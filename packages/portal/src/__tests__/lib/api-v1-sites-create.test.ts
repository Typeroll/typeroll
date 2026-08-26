// Tests for POST /api/v1/sites — create + bootstrap a new site via a bearer
// key (the surface behind the MCP `create_site` tool). Org-scoped keys may
// create; site-scoped keys are bound to one existing site and get 403.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, Page, Partial as PartialDoc } from '@typeroll/shared';

const ORG = 'agencyorg';
const EXISTING_SITE = 'existing';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  // A pre-existing site so a site-scoped key has something to bind to.
  await getStore().setDoc(paths.site(ORG, EXISTING_SITE), {
    name: 'Existing', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
}

async function makeKey(siteId: string | null): Promise<string> {
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({
    orgId: ORG, siteId, name: 'test', createdBy: 'admin@example.com',
  });
  return token;
}

async function createSiteReq(token: string | null, body: unknown): Promise<{ status: number; json: any }> {
  const mod = await import('../../pages/api/v1/sites/index') as { POST: APIRoute };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request('https://api.example/api/v1/sites', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const res = await mod.POST({
    request: req, params: {}, cookies: { get: () => undefined } as any, locals: {} as any,
  } as any) as Response;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

describe('POST /api/v1/sites', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('org-scoped key creates + bootstraps a new site', async () => {
    await setup();
    const token = await makeKey(null);
    const { status, json } = await createSiteReq(token, { name: 'Acme Studio' });
    expect(status).toBe(201);
    expect(json.site.id).toBe('acme-studio'); // slugified from name
    expect(json.site.name).toBe('Acme Studio');
    expect(json.site.urls).toBeDefined();

    // The bootstrap really landed: settings + draft home + header/footer.
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    const site = await store.getDoc<Site>(paths.site(ORG, 'acme-studio'));
    expect(site?.name).toBe('Acme Studio');
    const home = await store.getDoc<Page>(`${paths.pages(ORG, 'acme-studio')}/home`);
    expect(home?.slug).toBe('home');
    expect(home?.status).toBe('draft');
    const header = await store.getDoc<PartialDoc>(paths.partial(ORG, 'acme-studio', 'header'));
    expect(header?.kind).toBe('header');
    expect(header?.status).toBe('published');
  });

  it('site-scoped key cannot create (403)', async () => {
    await setup();
    const token = await makeKey(EXISTING_SITE);
    const { status, json } = await createSiteReq(token, { name: 'Nope' });
    expect(status).toBe(403);
    expect(String(json.error)).toMatch(/org-scoped/i);
    // Nothing was written.
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc<Site>(paths.site(ORG, 'nope'))).toBeNull();
  });

  it('400 when name is missing', async () => {
    await setup();
    const token = await makeKey(null);
    const { status } = await createSiteReq(token, { domain: 'x.com' });
    expect(status).toBe(400);
  });

  it('401 without a bearer token', async () => {
    await setup();
    const { status } = await createSiteReq(null, { name: 'Acme' });
    expect(status).toBe(401);
  });
});
