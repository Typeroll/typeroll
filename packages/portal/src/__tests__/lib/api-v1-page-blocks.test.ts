// End-to-end-ish test for the page block-tree mutation routes.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Page, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({
    orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com',
  });
  return { token };
}

async function seedPage(id: string, page: Partial<Page>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, status: 'published',
    content_mode: 'blocks', blocks: [], html_content: '', ...page,
  });
}

async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', APIRoute>>>,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  params: Record<string, string>,
  init?: { headers?: HeadersInit; body?: unknown },
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null && typeof init.body !== 'string'
    ? JSON.stringify(init.body)
    : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}

const bearer = (t: string): HeadersInit => ({ authorization: `Bearer ${t}` });

describe('Block tree mutations via /v1', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('GET → empty blocks for a fresh blocks-mode page', async () => {
    const { token } = await setup();
    await seedPage('home', { content_mode: 'blocks' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { content_mode: string; blocks: unknown[] };
    expect(body.content_mode).toBe('blocks');
    expect(body.blocks).toEqual([]);
  });

  it('POST adds a block, persists it, GET returns it', async () => {
    const { token } = await setup();
    await seedPage('home', { content_mode: 'blocks' });

    const addRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`,
      { siteId: SITE, pageId: 'home' },
      {
        headers: bearer(token),
        body: { block: { type: 'core/heading', data: { text: 'Hi', level: 'h2' } } },
      },
    );
    expect(addRes.status).toBe(200);
    const { added_id } = await addRes.json() as { added_id: string };
    expect(added_id).toMatch(/^blk_/);

    const getRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token) },
    );
    const got = await getRes.json() as { blocks: Array<{ id: string; type: string }> };
    expect(got.blocks).toHaveLength(1);
    expect(got.blocks[0].type).toBe('core/heading');
    expect(got.blocks[0].id).toBe(added_id);
  });

  it('PATCH updates block data', async () => {
    const { token } = await setup();
    await seedPage('home', {
      content_mode: 'blocks',
      blocks: [{ id: 'h1', type: 'core/heading', data: { text: 'Old' } }],
    });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`,
      { siteId: SITE, pageId: 'home' },
      {
        headers: bearer(token),
        body: { block_id: 'h1', data: { text: 'New' } },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { blocks: Array<{ id: string; data: { text: string } }> };
    expect(body.blocks[0].data.text).toBe('New');
  });

  it('PUT moves a block', async () => {
    const { token } = await setup();
    await seedPage('home', {
      content_mode: 'blocks',
      blocks: [
        { id: 'sec', type: 'core/section', data: {}, children: [
          { id: 'h1', type: 'core/heading', data: { text: 'Hi' } },
        ] },
      ],
    });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index'),
      'PUT',
      `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`,
      { siteId: SITE, pageId: 'home' },
      {
        headers: bearer(token),
        body: { block_id: 'h1', target_parent_id: null },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { blocks: Array<{ id: string }> };
    // h1 now at top level (alongside sec)
    expect(body.blocks.map((b) => b.id)).toContain('h1');
    expect(body.blocks).toHaveLength(2);
  });

  it('DELETE removes a block', async () => {
    const { token } = await setup();
    await seedPage('home', {
      content_mode: 'blocks',
      blocks: [
        { id: 'a', type: 'core/heading', data: {} },
        { id: 'b', type: 'core/heading', data: {} },
      ],
    });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/pages/home/blocks?block_id=a`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { blocks: Array<{ id: string }> };
    expect(body.blocks.map((b) => b.id)).toEqual(['b']);
  });

  it('404 when page not found', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages/ghost/blocks`,
      { siteId: SITE, pageId: 'ghost' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(404);
  });

  it('404 from mutation when block_id unknown', async () => {
    const { token } = await setup();
    await seedPage('home', { content_mode: 'blocks', blocks: [] });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token), body: { block_id: 'ghost', data: {} } },
    );
    expect(res.status).toBe(404);
  });
});

describe('Convert HTML → blocks via /v1', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('dry_run returns proposed blocks without writing', async () => {
    const { token } = await setup();
    await seedPage('about', {
      content_mode: 'html',
      html_content: '<h1>About</h1><p>We are great.</p>',
    });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/convert'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/about/blocks/convert`,
      { siteId: SITE, pageId: 'about' },
      { headers: bearer(token), body: { dry_run: true } },
    );
    const body = await res.json() as { applied: boolean; blocks: unknown[]; summary: unknown[] };
    expect(body.applied).toBe(false);
    expect(body.blocks.length).toBeGreaterThan(0);

    // Verify nothing was written
    const { getStore } = await import('../../lib/datastore');
    const page = await getStore().getDoc<Page>(
      `${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/about`,
    );
    expect(page!.content_mode).toBe('html');
    expect(page!.blocks ?? []).toHaveLength(0);
  });

  it('dry_run=false with switch_mode=true flips the page to blocks', async () => {
    const { token } = await setup();
    await seedPage('about', {
      content_mode: 'html',
      html_content: '<h1>About</h1>',
    });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/convert'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/about/blocks/convert`,
      { siteId: SITE, pageId: 'about' },
      { headers: bearer(token), body: { dry_run: false, switch_mode: true } },
    );
    const body = await res.json() as { applied: boolean; switched_mode: boolean };
    expect(body.applied).toBe(true);
    expect(body.switched_mode).toBe(true);

    const { getStore } = await import('../../lib/datastore');
    const page = await getStore().getDoc<Page>(
      `${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/about`,
    );
    expect(page!.content_mode).toBe('blocks');
    expect((page!.blocks ?? []).length).toBeGreaterThan(0);
  });

  it('empty html_content returns 200 with empty proposal', async () => {
    const { token } = await setup();
    await seedPage('blank', { content_mode: 'html', html_content: '' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/convert'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/blank/blocks/convert`,
      { siteId: SITE, pageId: 'blank' },
      { headers: bearer(token), body: { dry_run: true } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { blocks: unknown[]; notes: string[] };
    expect(body.blocks).toEqual([]);
    expect(body.notes.length).toBeGreaterThan(0);
  });
});
