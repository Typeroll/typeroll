// /api/sites/{siteId}/pages/{pageId}/mode
//   - HTML → blocks (with + without auto-convert)
//   - Blocks → HTML (destroys block tree, snapshots first)
//   - no-op when already in target mode
//   - revision is always written before the flip

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Page, Revision, Site, SiteVersion } from '@typeroll/shared';

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

async function seedPage(over: Partial<Page>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const page: Page = {
    id: 'home',
    title: 'Home',
    slug: 'home',
    content_mode: 'html',
    status: 'published',
    html_content: '<h1>Hello</h1><p>Welcome to my site</p>',
    ...over,
  };
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, page);
}

async function call(body: unknown): Promise<Response> {
  const mod = await import('../../pages/api/sites/[siteId]/pages/[pageId]/mode');
  const handler = mod.POST as APIRoute;
  const req = new Request('http://localhost/api/sites/mysite/pages/home/mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handler({
    request: req,
    params: { siteId: SITE, pageId: 'home' },
    cookies: { get: () => undefined } as any,
    locals: {} as any,
  } as any) as Promise<Response>;
}

describe('POST /pages/{id}/mode — HTML → blocks', () => {
  beforeEach(async () => { await setup(); });

  it('switches mode without conversion (empty blocks)', async () => {
    await seedPage({});
    const res = await call({ to: 'blocks' });
    expect(res.status).toBe(200);

    const { getStore } = await import('../../lib/datastore');
    const page = await getStore().getDoc<Page>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`);
    expect(page!.content_mode).toBe('blocks');
    expect(page!.blocks).toEqual([]);
    // html_content stays as backup
    expect(page!.html_content).toContain('Hello');
  });

  it('runs the converter when convert=true', async () => {
    await seedPage({});
    const res = await call({ to: 'blocks', convert: true });
    expect(res.status).toBe(200);

    const { getStore } = await import('../../lib/datastore');
    const page = await getStore().getDoc<Page>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`);
    expect(page!.content_mode).toBe('blocks');
    expect((page!.blocks ?? []).length).toBeGreaterThan(0);
    expect(page!.blocks![0].type).toBe('core/heading');
  });

  it('writes a revision before the flip', async () => {
    await seedPage({});
    await call({ to: 'blocks' });
    const { getStore } = await import('../../lib/datastore');
    const revs = await getStore().listDocs<Revision>(paths.revisions(ORG, SITE, 'home', MAIN_VERSION_ID));
    expect(revs.length).toBe(1);
    expect(revs[0].note).toContain('html → blocks');
  });
});

describe('POST /pages/{id}/mode — blocks → HTML', () => {
  beforeEach(async () => { await setup(); });

  it('drops the block tree (revision retains it)', async () => {
    await seedPage({
      content_mode: 'blocks',
      blocks: [
        { id: 'a', type: 'core/heading', data: { text: 'Hi' } },
        { id: 'b', type: 'core/prose', data: { html: '<p>x</p>' } },
      ],
      html_content: '',
    });

    const res = await call({ to: 'html' });
    expect(res.status).toBe(200);

    const { getStore } = await import('../../lib/datastore');
    const page = await getStore().getDoc<Page>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`);
    expect(page!.content_mode).toBe('html');
    expect(page!.blocks).toEqual([]);

    const revs = await getStore().listDocs<Revision<Partial<Page>>>(paths.revisions(ORG, SITE, 'home', MAIN_VERSION_ID));
    expect(revs.length).toBe(1);
    expect(revs[0].doc.blocks).toHaveLength(2);
    expect(revs[0].note).toContain('blocks → html');
  });
});

describe('POST /pages/{id}/mode — no-op', () => {
  beforeEach(async () => { await setup(); });

  it('returns ok+unchanged when already in target mode', async () => {
    await seedPage({});
    const res = await call({ to: 'html' });
    expect(res.status).toBe(200);
    const body = await res.json() as { unchanged?: boolean };
    expect(body.unchanged).toBe(true);
  });
});

describe('POST /pages/{id}/mode — validation', () => {
  beforeEach(async () => { await setup(); });

  it('rejects invalid target mode', async () => {
    await seedPage({});
    const res = await call({ to: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('404 for missing page', async () => {
    const mod = await import('../../pages/api/sites/[siteId]/pages/[pageId]/mode');
    const req = new Request('http://localhost/api/sites/mysite/pages/ghost/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'blocks' }),
    });
    const res = await (mod.POST as APIRoute)({
      request: req, params: { siteId: SITE, pageId: 'ghost' },
      cookies: { get: () => undefined } as any, locals: {} as any,
    } as any) as Response;
    expect(res.status).toBe(404);
  });
});
