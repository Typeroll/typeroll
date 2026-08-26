// POST /api/sites/{id}/pages/create now defaults content_mode to "blocks"
// with a seeded heading + prose block. Caller can pass content_mode=html
// to opt out.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Page, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  vi.doMock('../../lib/access', async () => {
    const actual = await vi.importActual<typeof import('../../lib/access')>('../../lib/access');
    return {
      ...actual,
      requireSiteAccess: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: { orgId: ORG, userId: 'u1' },
          site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', status: 'live', created_at: '' },
          versionId: MAIN_VERSION_ID,
          owner_org_id: ORG,
          permission: 'admin' as const,
        },
      })),
    };
  });
}

async function callCreate(formFields: Record<string, string>): Promise<Response> {
  const mod = await import('../../pages/api/sites/[siteId]/pages/create');
  const form = new FormData();
  for (const [k, v] of Object.entries(formFields)) form.append(k, v);
  const req = new Request('http://localhost/api/sites/mysite/pages/create', {
    method: 'POST', body: form,
  });
  return (mod.POST as APIRoute)({
    request: req,
    params: { siteId: SITE },
    cookies: { get: () => undefined } as any,
    locals: {} as any,
    redirect: (loc: string) => new Response(null, { status: 302, headers: { location: loc } }),
  } as any) as Promise<Response>;
}

async function loadCreatedPage(slug: string): Promise<Page | null> {
  const { getStore } = await import('../../lib/datastore');
  return getStore().getDoc<Page>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${slug}`);
}

describe('Create page — default content_mode', () => {
  beforeEach(async () => { await setup(); });

  it('defaults to blocks mode with a seeded heading + prose block', async () => {
    const res = await callCreate({ title: 'About us' });
    expect(res.status).toBe(302);
    const page = await loadCreatedPage('about-us');
    expect(page).toBeTruthy();
    expect(page!.content_mode).toBe('blocks');
    expect(page!.blocks).toHaveLength(2);
    expect(page!.blocks![0].type).toBe('core/heading');
    expect((page!.blocks![0].data as { text: string }).text).toBe('About us');
    expect(page!.blocks![1].type).toBe('core/prose');
    expect(page!.html_content).toBeUndefined();
  });

  it('honors content_mode=html opt-out', async () => {
    const res = await callCreate({ title: 'Old way', content_mode: 'html' });
    expect(res.status).toBe(302);
    const page = await loadCreatedPage('old-way');
    expect(page!.content_mode).toBe('html');
    expect(page!.html_content).toContain('<h1>Old way</h1>');
    expect(page!.blocks).toBeUndefined();
  });

  it('falls back to blocks for any other content_mode value', async () => {
    const res = await callCreate({ title: 'Weird', content_mode: 'something' });
    const page = await loadCreatedPage('weird');
    expect(page!.content_mode).toBe('blocks');
  });
});
