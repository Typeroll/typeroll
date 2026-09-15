// Tests for partials, block-types, page-blocks, endpoints.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion } from '@typeroll/shared';

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

interface CallInit {
  headers?: HeadersInit;
  body?: unknown;
}
async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', APIRoute>>>,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  params: Record<string, string>,
  init?: CallInit,
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
function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function seedPartial(id: string, doc: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    name: id, kind: 'free', status: 'published', content_mode: 'html', html_content: '<p>seed</p>', ...doc,
  });
}

async function seedPage(id: string, doc: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, content_mode: 'html', status: 'published', html_content: '<p>seed</p>', ...doc,
  });
}

describe('partials endpoints', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('GET / returns the partials list', async () => {
    const { token } = await setup();
    await seedPartial('cta', { name: 'CTA' });
    await seedPartial('newsletter', { name: 'Newsletter' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/partials`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { partials: Array<{ id: string }> };
    expect(body.partials.map((p) => p.id).sort()).toEqual(['cta', 'newsletter']);
  });

  it('POST / creates a free block', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/partials`,
      { siteId: SITE },
      { headers: bearer(token), body: { id: 'newsletter-cta', name: 'Newsletter CTA', html_content: '<form></form>' } },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { partial: { id: string; kind: string } };
    expect(body.partial.id).toBe('newsletter-cta');
    expect(body.partial.kind).toBe('free');
  });

  it('POST / 409 on duplicate id', async () => {
    const { token } = await setup();
    await seedPartial('cta', {});
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/partials`,
      { siteId: SITE },
      { headers: bearer(token), body: { id: 'cta', html_content: '<p>x</p>' } },
    );
    expect(res.status).toBe(409);
  });

  it('POST / rejects "header" / "footer" — those go through PUT', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/partials`,
      { siteId: SITE },
      { headers: bearer(token), body: { id: 'header', html_content: '<nav></nav>' } },
    );
    expect(res.status).toBe(400);
  });

  it('PATCH /{id} updates writable fields and sanitizes html', async () => {
    const { token } = await setup();
    await seedPartial('cta', { html_content: '<p>old</p>' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/[partialId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/partials/cta`,
      { siteId: SITE, partialId: 'cta' },
      { headers: bearer(token), body: { html_content: '<p>new</p><script>alert(1)</script>' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { partial: { html_content: string } };
    expect(body.partial.html_content).toContain('<p>new</p>');
    expect(body.partial.html_content).not.toContain('<script');
  });

  it('switches a partial to blocks mode and returns the rendered tree', async () => {
    const { token } = await setup();
    await seedPartial('header', {
      kind: 'header',
      blocks: [{ id: 'logo', type: 'template/site_logo', data: { height: 'md' } }],
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/[partialId]/mode'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/partials/header/mode`,
      { siteId: SITE, partialId: 'header' },
      { headers: bearer(token), body: { to: 'blocks', convert: false } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { content_mode: string; blocks: Array<{ type: string }> };
    expect(body.content_mode).toBe('blocks');
    expect(body.blocks[0]?.type).toBe('template/site_logo');

    const read = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/[partialId]'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/partials/header`,
      { siteId: SITE, partialId: 'header' },
      { headers: bearer(token) },
    );
    const readBody = await read.json() as { partial: { content_mode: string; blocks: unknown[]; html_content?: string } };
    expect(readBody.partial).toMatchObject({ content_mode: 'blocks' });
    expect(readBody.partial.blocks).toHaveLength(1);
    expect(readBody.partial.html_content).toBeUndefined();
  });

  it('rejects content_mode on partial PATCH with mode endpoint guidance', async () => {
    const { token } = await setup();
    await seedPartial('header', { kind: 'header' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/[partialId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/partials/header`,
      { siteId: SITE, partialId: 'header' },
      { headers: bearer(token), body: { content_mode: 'blocks' } },
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('/mode');
  });

  it('DELETE /{id} works for free blocks but not header/footer', async () => {
    const { token } = await setup();
    await seedPartial('cta', {});
    await seedPartial('header', { kind: 'header' });

    const ok = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/[partialId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/partials/cta`,
      { siteId: SITE, partialId: 'cta' },
      { headers: bearer(token) },
    );
    expect(ok.status).toBe(200);

    const blocked = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/[partialId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/partials/header`,
      { siteId: SITE, partialId: 'header' },
      { headers: bearer(token) },
    );
    expect(blocked.status).toBe(400);
  });

  it('GET /{id}/usage returns pages embedding the block', async () => {
    const { token } = await setup();
    await seedPartial('cta', {});
    await seedPage('home', { html_content: '<x-include name="cta" />' });
    await seedPage('about', { html_content: '<p>no block</p>' });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/[partialId]/usage'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/partials/cta/usage`,
      { siteId: SITE, partialId: 'cta' },
      { headers: bearer(token) },
    );
    const body = await res.json() as { pages: Array<{ page_id: string }> };
    expect(body.pages.map((p) => p.page_id)).toEqual(['home']);
  });

  it('GET /header/usage reports auto_injected + every page', async () => {
    const { token } = await setup();
    await seedPage('home', {});
    await seedPage('about', {});
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/[partialId]/usage'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/partials/header/usage`,
      { siteId: SITE, partialId: 'header' },
      { headers: bearer(token) },
    );
    const body = await res.json() as { auto_injected: boolean; pages: Array<{ page_id: string }> };
    expect(body.auto_injected).toBe(true);
    expect(body.pages.map((p) => p.page_id).sort()).toEqual(['about', 'home']);
  });
});

describe('block-types endpoints', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('GET / returns the (often empty) list', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/block-types/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/block-types`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { block_types: unknown[] };
    expect(Array.isArray(body.block_types)).toBe(true);
  });

  it('GET /{typeId}/usage returns empty for HTML-mode-only sites', async () => {
    const { token } = await setup();
    await seedPage('home', { content_mode: 'html' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/block-types/[typeId]/usage'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/block-types/hero/usage`,
      { siteId: SITE, typeId: 'hero' },
      { headers: bearer(token) },
    );
    const body = await res.json() as { pages: unknown[] };
    expect(body.pages).toEqual([]);
  });
});

describe('GET /pages/{pageId}/blocks', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('returns content_mode: html for HTML pages', async () => {
    const { token } = await setup();
    await seedPage('home', { content_mode: 'html', html_content: '<h1>hi</h1>' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token) },
    );
    const body = await res.json() as { content_mode: string; html_content?: string };
    expect(body.content_mode).toBe('html');
    expect(body.html_content).toBe('<h1>hi</h1>');
  });
});
