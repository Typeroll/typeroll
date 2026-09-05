// Regression: the v1 block-mutation routes used to silently ignore unknown
// body keys. A caller sending { block_id, patch: { data } } got a 200 with
// the unchanged tree — updateBlock() applied nothing — and believed the
// write succeeded. The routes now reject unknown keys and no-op PATCHes
// with a 400 that names the offending/missing keys.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Page, Site, SiteVersion } from '@typeroll/shared';
import { bodyShapeError } from '../../lib/api-body';

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

const pagesRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index');
const pagesUrl = `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`;
const pagesParams = { siteId: SITE, pageId: 'home' };

const containersRoute = () => import('../../pages/api/v1/sites/[siteId]/containers/[kind]/[id]/blocks/index');
const containersUrl = `http://localhost/api/v1/sites/${SITE}/containers/page/home/blocks`;
const containersParams = { siteId: SITE, kind: 'page', id: 'home' };

const heading = { id: 'h1', type: 'core/heading', data: { text: 'Old' } };

describe('bodyShapeError', () => {
  it('passes a clean body', () => {
    expect(bodyShapeError({ block_id: 'x', data: {} }, ['block_id', 'data'])).toBeNull();
  });

  it('names every unknown key and lists the accepted ones', () => {
    const msg = bodyShapeError({ block_id: 'x', patch: {}, foo: 1 }, ['block_id', 'data']);
    expect(msg).toContain('patch');
    expect(msg).toContain('foo');
    expect(msg).toContain('block_id, data');
  });

  it('requireOneOf rejects when none of the listed keys are present', () => {
    const msg = bodyShapeError({ block_id: 'x' }, ['block_id', 'data'], { requireOneOf: ['data'] });
    expect(msg).toContain('data');
  });
});

describe('PATCH body validation — /pages/{pageId}/blocks', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('unknown key ("patch") → 400 naming the key and the accepted keys', async () => {
    const { token } = await setup();
    await seedPage('home', { blocks: [heading] });
    const res = await callRoute(pagesRoute(), 'PATCH', pagesUrl, pagesParams, {
      headers: bearer(token),
      body: { block_id: 'h1', patch: { data: { text: 'New' } } },
    });
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    expect(error).toContain('patch');
    expect(error).toContain('data');
    expect(error).toContain('style_overrides');
    expect(error).not.toContain('responsive');
  });

  it('only block_id (nothing to update) → 400 listing the updatable fields', async () => {
    const { token } = await setup();
    await seedPage('home', { blocks: [heading] });
    const res = await callRoute(pagesRoute(), 'PATCH', pagesUrl, pagesParams, {
      headers: bearer(token),
      body: { block_id: 'h1' },
    });
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    expect(error).toContain('data');
    expect(error).toContain('style_overrides');
    expect(error).not.toContain('responsive');
  });

  it('valid PATCH still works', async () => {
    const { token } = await setup();
    await seedPage('home', { blocks: [heading] });
    const res = await callRoute(pagesRoute(), 'PATCH', pagesUrl, pagesParams, {
      headers: bearer(token),
      body: { block_id: 'h1', data: { text: 'New' } },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { blocks: Array<{ data: { text: string } }> };
    expect(body.blocks[0].data.text).toBe('New');
  });

  it('POST with unknown key → 400', async () => {
    const { token } = await setup();
    await seedPage('home', { blocks: [] });
    const res = await callRoute(pagesRoute(), 'POST', pagesUrl, pagesParams, {
      headers: bearer(token),
      body: { block: { type: 'core/heading' }, after_block_id: 'h1' },
    });
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    expect(error).toContain('after_block_id');
    expect(error).toContain('parent_id');
  });

  it('PUT with unknown key → 400', async () => {
    const { token } = await setup();
    await seedPage('home', { blocks: [heading] });
    const res = await callRoute(pagesRoute(), 'PUT', pagesUrl, pagesParams, {
      headers: bearer(token),
      body: { block_id: 'h1', parent_id: null },
    });
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    expect(error).toContain('parent_id');
    expect(error).toContain('target_parent_id');
  });
});

describe('PATCH body validation — /containers/{kind}/{id}/blocks', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('unknown key → 400 naming the key', async () => {
    const { token } = await setup();
    await seedPage('home', { blocks: [heading] });
    const res = await callRoute(containersRoute(), 'PATCH', containersUrl, containersParams, {
      headers: bearer(token),
      body: { block_id: 'h1', patch: { data: { text: 'New' } } },
    });
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    expect(error).toContain('patch');
  });

  it('only block_id → 400', async () => {
    const { token } = await setup();
    await seedPage('home', { blocks: [heading] });
    const res = await callRoute(containersRoute(), 'PATCH', containersUrl, containersParams, {
      headers: bearer(token),
      body: { block_id: 'h1' },
    });
    expect(res.status).toBe(400);
  });

  it('valid PATCH still works', async () => {
    const { token } = await setup();
    await seedPage('home', { blocks: [heading] });
    const res = await callRoute(containersRoute(), 'PATCH', containersUrl, containersParams, {
      headers: bearer(token),
      body: { block_id: 'h1', data: { text: 'New' } },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { blocks: Array<{ data: { text: string } }> };
    expect(body.blocks[0].data.text).toBe('New');
  });
});

describe('body validation — sibling block routes', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('duplicate with unknown key → 400', async () => {
    const { token } = await setup();
    await seedPage('home', { blocks: [heading] });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/duplicate'),
      'POST', `${pagesUrl}/duplicate`, pagesParams,
      { headers: bearer(token), body: { block_id: 'h1', count: 2 } },
    );
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    expect(error).toContain('count');
  });

  it('responsive with unknown key → 400', async () => {
    const { token } = await setup();
    await seedPage('home', { blocks: [heading] });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/containers/[kind]/[id]/blocks/responsive'),
      'POST', `${containersUrl}/responsive`, containersParams,
      { headers: bearer(token), body: { block_id: 'h1', field: 'size', values: {} } },
    );
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    expect(error).toContain('values');
  });

  it('convert with unknown key → 400', async () => {
    const { token } = await setup();
    await seedPage('home', { content_mode: 'html', html_content: '<h1>Hi</h1>' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/convert'),
      'POST', `${pagesUrl}/convert`, pagesParams,
      { headers: bearer(token), body: { dryRun: true } },
    );
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    expect(error).toContain('dryRun');
    expect(error).toContain('dry_run');
  });
});
