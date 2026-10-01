// The public API offers what a site admin can do in the portal, with the same
// permission checks: settings the portal form accepts, the "Allow AI to write
// block scripts" toggle, archive/restore, purging an archived site's media and
// the media upload pre-flight.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths, ARCHIVED_SITE_MESSAGE } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Media, Site, SiteShare, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const OTHER_ORG = 'ownerorg';
const SHARED = 'shared-site';

type Method = 'GET' | 'POST' | 'PATCH';

async function setup(opts: { site?: Partial<Site>; sharePermission?: 'read' | 'write' | 'admin' } = {}) {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  for (const [org, site] of [[ORG, SITE], [OTHER_ORG, SHARED]] as const) {
    await store.setDoc(paths.site(org, site), {
      name: site, created_at: new Date().toISOString(), ...(site === SITE ? opts.site : {}),
    } satisfies Partial<Site>);
    await store.setDoc(paths.version(org, site, MAIN_VERSION_ID), {
      name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
    } satisfies Partial<SiteVersion>);
  }
  const { writeShare } = await import('../../lib/shares');
  await writeShare({
    id: 'share-1', site_id: SHARED, owner_org_id: OTHER_ORG, shared_with_org_id: ORG,
    permission: opts.sharePermission ?? 'admin', created_at: Date.now(), created_by: 'owner@example.com',
  } satisfies SiteShare);
  const { createApiKey } = await import('../../lib/api-keys');
  const siteKey = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'site', createdBy: 'admin@example.com' })).token;
  const orgKey = (await createApiKey({ orgId: ORG, siteId: null, name: 'org', createdBy: 'admin@example.com' })).token;
  return { siteKey, orgKey };
}

async function call(
  route: Promise<Partial<Record<Method, APIRoute>>>,
  method: Method,
  path: string,
  params: Record<string, string>,
  token: string,
  body?: unknown,
): Promise<Response> {
  const handler = (await route)[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler({ request, params, cookies: { get: () => undefined } as never, locals: {} as never } as never) as Promise<Response>;
}

const settingsRoute = () => import('../../pages/api/v1/sites/[siteId]/settings');
const siteRoute = () => import('../../pages/api/v1/sites/[siteId]/index');
const lifecycleRoute = () => import('../../pages/api/v1/sites/[siteId]/lifecycle');
const purgeRoute = () => import('../../pages/api/v1/sites/[siteId]/media/purge');
const uploadStatusRoute = () => import('../../pages/api/v1/sites/[siteId]/media/upload-status');

async function siteDoc(org = ORG, site = SITE): Promise<Site | null> {
  const { getStore } = await import('../../lib/datastore');
  return getStore().getDoc<Site>(paths.site(org, site));
}

describe('PATCH /v1/sites/{siteId}/settings — portal form parity', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('accepts default_og_image, twitter_handle and organization as the portal form stores them', async () => {
    const { siteKey } = await setup();
    const res = await call(settingsRoute(), 'PATCH', `/api/v1/sites/${SITE}/settings`, { siteId: SITE }, siteKey, {
      default_og_image: 'https://cdn.example.com/og.png',
      twitter_handle: '@acme',
      organization: { name: ' Acme AB ', logo: 'https://cdn.example.com/logo.png', same_as: ['https://x.com/acme', '  '] },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { updated_fields: string[] };
    expect(body.updated_fields.sort()).toEqual(['default_og_image', 'organization', 'twitter_handle']);
    const { vstore } = await import('../../lib/version-store');
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    expect(settings?.default_og_image).toBe('https://cdn.example.com/og.png');
    expect(settings?.twitter_handle).toBe('acme');
    expect(settings?.organization).toEqual({ name: 'Acme AB', logo: 'https://cdn.example.com/logo.png', same_as: ['https://x.com/acme'] });
  });

  it('clears those fields with an empty string or null', async () => {
    const { siteKey } = await setup();
    const { vstore } = await import('../../lib/version-store');
    await vstore.writeSettings(ORG, SITE, MAIN_VERSION_ID, {
      default_og_image: 'https://cdn.example.com/og.png', twitter_handle: 'acme', organization: { name: 'Acme', same_as: [] },
    });
    const res = await call(settingsRoute(), 'PATCH', `/api/v1/sites/${SITE}/settings`, { siteId: SITE }, siteKey, {
      default_og_image: '', twitter_handle: null, organization: null,
    });
    expect(res.status).toBe(200);
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    expect(settings?.default_og_image).toBeUndefined();
    expect(settings?.twitter_handle).toBeUndefined();
    expect(settings?.organization).toBeUndefined();
  });

  it('rejects malformed organization values', async () => {
    const { siteKey } = await setup();
    for (const organization of ['Acme', { name: 'Acme', same_as: 'https://x.com/acme' }, { name: 'Acme', url: 'x' }]) {
      const res = await call(settingsRoute(), 'PATCH', `/api/v1/sites/${SITE}/settings`, { siteId: SITE }, siteKey, { organization });
      expect(res.status).toBe(400);
    }
  });

  it('writes staging_url to the Site document, whichever version is addressed', async () => {
    const { siteKey } = await setup();
    const res = await call(settingsRoute(), 'PATCH', `/api/v1/sites/${SITE}/settings`, { siteId: SITE }, siteKey, {
      staging_url: ' https://staging.example.com/// ',
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { updated_fields: string[] }).updated_fields).toEqual(['staging_url']);
    expect((await siteDoc())?.staging_url).toBe('https://staging.example.com');
    const { vstore } = await import('../../lib/version-store');
    expect((await vstore.settings(ORG, SITE, MAIN_VERSION_ID) as Record<string, unknown> | null)?.staging_url).toBeUndefined();

    const read = await call(settingsRoute(), 'GET', `/api/v1/sites/${SITE}/settings`, { siteId: SITE }, siteKey);
    expect((await read.json() as { urls: { staging: string } }).urls.staging).toBe('https://staging.example.com');

    await call(settingsRoute(), 'PATCH', `/api/v1/sites/${SITE}/settings`, { siteId: SITE }, siteKey, { staging_url: '' });
    expect((await siteDoc())?.staging_url ?? null).toBeNull();
  });

  it('requires admin, like the portal Settings form', async () => {
    const { orgKey } = await setup({ sharePermission: 'write' });
    const res = await call(settingsRoute(), 'PATCH', `/api/v1/sites/${SHARED}/settings`, { siteId: SHARED }, orgKey, { site_name: 'X' });
    expect(res.status).toBe(403);
  });

  it('lets an admin share change settings', async () => {
    const { orgKey } = await setup({ sharePermission: 'admin' });
    const res = await call(settingsRoute(), 'PATCH', `/api/v1/sites/${SHARED}/settings`, { siteId: SHARED }, orgKey, { site_name: 'X' });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /v1/sites/{siteId} — ai_scripts_enabled', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('sets and clears the flag and reports it on GET', async () => {
    const { siteKey } = await setup();
    const on = await call(siteRoute(), 'PATCH', `/api/v1/sites/${SITE}`, { siteId: SITE }, siteKey, { ai_scripts_enabled: true });
    expect(on.status).toBe(200);
    expect((await on.json() as { ai_scripts_enabled: boolean }).ai_scripts_enabled).toBe(true);
    expect((await siteDoc())?.ai_scripts_enabled).toBe(true);

    const off = await call(siteRoute(), 'PATCH', `/api/v1/sites/${SITE}`, { siteId: SITE }, siteKey, { ai_scripts_enabled: false });
    expect(off.status).toBe(200);
    const read = await call(siteRoute(), 'GET', `/api/v1/sites/${SITE}`, { siteId: SITE }, siteKey);
    expect((await read.json() as { ai_scripts_enabled: boolean }).ai_scripts_enabled).toBe(false);
  });

  it('rejects a non-boolean value', async () => {
    const { siteKey } = await setup();
    const res = await call(siteRoute(), 'PATCH', `/api/v1/sites/${SITE}`, { siteId: SITE }, siteKey, { ai_scripts_enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('requires admin, like the portal toggle', async () => {
    const { orgKey } = await setup({ sharePermission: 'write' });
    const res = await call(siteRoute(), 'PATCH', `/api/v1/sites/${SHARED}`, { siteId: SHARED }, orgKey, { ai_scripts_enabled: true });
    expect(res.status).toBe(403);
    expect((await siteDoc(OTHER_ORG, SHARED))?.ai_scripts_enabled).toBeUndefined();
  });
});

describe('/v1/sites/{siteId}/lifecycle', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('archives with the key as actor, freezes writes, and restores', async () => {
    const { siteKey } = await setup();
    const archived = await call(lifecycleRoute(), 'POST', `/api/v1/sites/${SITE}/lifecycle`, { siteId: SITE }, siteKey, {
      action: 'archive', reason: 'Retired campaign',
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ status: 'archived', site: SITE, message: ARCHIVED_SITE_MESSAGE });
    const doc = await siteDoc();
    expect(doc?.lifecycle?.status).toBe('archived');
    expect(doc?.lifecycle?.archived_by).toMatch(/^api-key:/);
    expect(doc?.lifecycle?.reason).toBe('Retired campaign');

    const state = await call(lifecycleRoute(), 'GET', `/api/v1/sites/${SITE}/lifecycle`, { siteId: SITE }, siteKey);
    expect(await state.json()).toMatchObject({ status: 'archived', reason: 'Retired campaign' });

    // Any other write is refused while archived.
    const write = await call(settingsRoute(), 'PATCH', `/api/v1/sites/${SITE}/settings`, { siteId: SITE }, siteKey, { site_name: 'X' });
    expect(write.status).toBe(409);

    // Idempotent.
    const again = await call(lifecycleRoute(), 'POST', `/api/v1/sites/${SITE}/lifecycle`, { siteId: SITE }, siteKey, { action: 'archive' });
    expect(again.status).toBe(200);

    const restored = await call(lifecycleRoute(), 'POST', `/api/v1/sites/${SITE}/lifecycle`, { siteId: SITE }, siteKey, { action: 'restore' });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ status: 'active', site: SITE });
    expect((await siteDoc())?.lifecycle ?? null).toBeNull();
  });

  it('works with an org-scoped key of the owning organization', async () => {
    const { orgKey } = await setup();
    const res = await call(lifecycleRoute(), 'POST', `/api/v1/sites/${SITE}/lifecycle`, { siteId: SITE }, orgKey, { action: 'archive' });
    expect(res.status).toBe(200);
  });

  it('refuses a cross-org share however privileged, as the portal does', async () => {
    const { orgKey } = await setup({ sharePermission: 'admin' });
    const res = await call(lifecycleRoute(), 'POST', `/api/v1/sites/${SHARED}/lifecycle`, { siteId: SHARED }, orgKey, { action: 'archive' });
    expect(res.status).toBe(403);
    expect((await siteDoc(OTHER_ORG, SHARED))?.lifecycle).toBeUndefined();
  });

  it('refuses to archive a site whose custom domain is live', async () => {
    const { siteKey } = await setup({ site: { domain: 'example.com', domain_status: 'live' } });
    const res = await call(lifecycleRoute(), 'POST', `/api/v1/sites/${SITE}/lifecycle`, { siteId: SITE }, siteKey, { action: 'archive' });
    expect(res.status).toBe(409);
  });

  it('rejects an unknown action', async () => {
    const { siteKey } = await setup();
    const res = await call(lifecycleRoute(), 'POST', `/api/v1/sites/${SITE}/lifecycle`, { siteId: SITE }, siteKey, { action: 'delete' });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/sites/{siteId}/media/purge', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    await resetDatastore();
    for (const name of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  async function seedMedia(): Promise<void> {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.media(ORG, SITE)}/plain`, { filename: 'a.png', cdn_url: '', mime_type: 'image/png' } as Partial<Media>);
    await getStore().setDoc(`${paths.media(ORG, SITE)}/stored`, { filename: 'b.png', cdn_url: '', mime_type: 'image/png', r2_key: 'media/x/b.png' } as Partial<Media>);
  }

  it('refuses an active site', async () => {
    const { siteKey } = await setup();
    const res = await call(purgeRoute(), 'POST', `/api/v1/sites/${SITE}/media/purge`, { siteId: SITE }, siteKey);
    expect(res.status).toBe(409);
  });

  it('purges an archived site and reports retained records with 207', async () => {
    const { siteKey } = await setup({ site: { lifecycle: { status: 'archived', archived_at: '2026-09-30T00:00:00Z', archived_by: 'u1' } } });
    await seedMedia();
    const res = await call(purgeRoute(), 'POST', `/api/v1/sites/${SITE}/media/purge`, { siteId: SITE }, siteKey);
    expect(res.status).toBe(207);
    const body = await res.json() as { records: number; records_removed: number; records_retained: number; failed: Array<{ media_id: string }> };
    expect(body.records).toBe(2);
    expect(body.records_removed).toBe(1);
    expect(body.records_retained).toBe(1);
    expect(body.failed.map((f) => f.media_id)).toEqual(['stored']);
  });

  it('refuses a cross-org share', async () => {
    const { orgKey } = await setup({ sharePermission: 'admin' });
    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(paths.site(OTHER_ORG, SHARED), { lifecycle: { status: 'archived', archived_at: 'x', archived_by: 'u1' } });
    const res = await call(purgeRoute(), 'POST', `/api/v1/sites/${SHARED}/media/purge`, { siteId: SHARED }, orgKey);
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/sites/{siteId}/media/upload-status', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('reports the same pre-flight as the portal media library', async () => {
    const { orgKey } = await setup({ sharePermission: 'read' });
    const saved = process.env.R2_BUCKET;
    delete process.env.R2_BUCKET;
    try {
      const res = await call(uploadStatusRoute(), 'GET', `/api/v1/sites/${SHARED}/media/upload-status`, { siteId: SHARED }, orgKey);
      expect(res.status).toBe(200);
      const body = await res.json() as { enabled: boolean; missing?: string[] };
      expect(body.enabled).toBe(false);
      expect(body.missing).toContain('R2_BUCKET');
    } finally {
      if (saved !== undefined) process.env.R2_BUCKET = saved;
    }
  });
});
