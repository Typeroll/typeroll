// Content export (anti-lock-in): GET /api/sites/{siteId}/export streams a
// zip of the site's full content in fixtures layout — the same
// materializeFixtures snapshot deploys build from — plus a manifest with
// media URLs. Admin-gated on both the cookie route and the v1 bearer route.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import JSZip from 'jszip';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteVersion, SharePermission } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function seed(): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await store.setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), {
    site_name: 'My Site', language: 'sv',
  });
  await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
    title: 'Home', slug: '', status: 'published', content_mode: 'blocks',
    blocks: [{ id: 'b1', type: 'core/prose', data: { text: '<p>Hej</p>' } }],
  });
  await store.setDoc(`${paths.media(ORG, SITE)}/img1`, {
    filename: 'a.webp', cdn_url: 'https://cdn.example/a.webp',
    variants: [{ width: 640, format: 'webp', cdn_url: 'https://cdn.example/a-640.webp', size_bytes: 1000 }],
    created_at: new Date().toISOString(),
  });
}

function mockAccess(permission: SharePermission): void {
  vi.doMock('../../lib/access', async () => {
    const actual = await vi.importActual<typeof import('../../lib/access')>('../../lib/access');
    return {
      ...actual,
      requireSiteAccess: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: { orgId: ORG, userId: 'u1', email: 't@example.com' },
          site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', status: 'live', created_at: '' },
          versionId: MAIN_VERSION_ID,
          owner_org_id: ORG,
          permission,
        },
      })),
    };
  });
}

async function callExport(): Promise<Response> {
  const mod = await import('../../pages/api/sites/[siteId]/export');
  return mod.GET({
    cookies: { get: () => undefined },
    params: { siteId: SITE },
  } as never) as Promise<Response>;
}

describe('content export route', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    vi.resetModules();
    await seed();
  });

  it('streams a zip containing the fixtures tree + manifest with media urls', async () => {
    mockAccess('admin');
    const res = await callExport();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(`${SITE}-content-`);

    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const names = Object.keys(zip.files);
    expect(names).toContain('export-manifest.json');
    expect(names.some((n) => n.endsWith(`pages/home.json`))).toBe(true);
    expect(names.some((n) => n.includes('settings'))).toBe(true);

    const manifest = JSON.parse(await zip.file('export-manifest.json')!.async('string'));
    expect(manifest).toMatchObject({
      format: 'typeroll-content-export',
      site_id: SITE,
      version_id: MAIN_VERSION_ID,
    });
    expect(manifest.media_urls).toEqual(
      expect.arrayContaining(['https://cdn.example/a.webp', 'https://cdn.example/a-640.webp']),
    );

    // The exported page round-trips as real JSON with content intact.
    const pageEntry = names.find((n) => n.endsWith('pages/home.json'))!;
    const page = JSON.parse(await zip.file(pageEntry)!.async('string'));
    expect(page.title).toBe('Home');
    expect(page.blocks[0].data.text).toContain('Hej');
  });

  it('write-permission sessions are rejected (admin required)', async () => {
    mockAccess('write');
    const res = await callExport();
    expect(res.status).toBe(403);
  });
});

describe('v1 bearer export route', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    vi.resetModules();
    await seed();
  });

  it('site-scoped key downloads the zip; unknown version 404s', async () => {
    const { createApiKey } = await import('../../lib/api-keys');
    const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 't', createdBy: 'admin' });
    const mod = await import('../../pages/api/v1/sites/[siteId]/export');
    const call = (url: string) =>
      mod.GET({
        request: new Request(url, { headers: { authorization: `Bearer ${token}` } }),
        params: { siteId: SITE },
      } as never) as Promise<Response>;

    const res = await call(`https://portal.example.com/api/v1/sites/${SITE}/export`);
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(Object.keys(zip.files)).toContain('export-manifest.json');

    const missing = await call(`https://portal.example.com/api/v1/sites/${SITE}/export?version=nope`);
    expect(missing.status).toBe(404);
  });
});
