// Unknown block data keys through the v1 block routes.
//
// From the moveria.se migration: `update_block data:{placeholder_background}`
// on the core/repeater "related-list" of the article template answered 200,
// stored the key at the repeater's top level and changed nothing (it is a
// core/post_card field, so it belongs in item_overrides), and `null` could
// not remove it again. Single-block writes now reject unknown keys with a
// suggestion; tree writes report them as warnings; `null` removes a key.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths, type Block, type Page, type Site, type SiteVersion } from '@typeroll/shared';
import type { APIRoute } from 'astro';

const ORG = 'orgone';
const SITE = 'mysite';

async function store() {
  return (await import('../../lib/datastore')).getStore();
}

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const s = await store();
  await s.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await s.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com' });
  return { token };
}

async function seedPage(id: string, blocks: Block[]): Promise<void> {
  await (await store()).setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, status: 'published', content_mode: 'blocks', blocks, html_content: '',
  } satisfies Partial<Page>);
}

const relatedList = (data: Record<string, unknown> = {}): Block => ({
  id: 'related-list', type: 'core/repeater',
  data: { source_type: 'related', field: 'related', content_type: 'articles', item_block: 'core/post_card', ...data },
});

async function seedTemplate(blocks: Block[]): Promise<void> {
  await (await store()).setDoc(paths.pageTemplate(ORG, SITE, 'content-type-articles', MAIN_VERSION_ID), {
    name: 'content-type-articles', label: 'Articles', status: 'published', created_at: '', blocks,
  });
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
async function call(
  route: Promise<Partial<Record<Method, APIRoute>>>,
  method: Method,
  url: string,
  params: Record<string, string>,
  token: string,
  body?: unknown,
): Promise<Response> {
  const handler = (await route)[method]!;
  const request = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler({ request, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}

const pageBlocks = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index');
const containerBlocks = () => import('../../pages/api/v1/sites/[siteId]/containers/[kind]/[id]/blocks/index');
const pageUrl = `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`;
const pageParams = { siteId: SITE, pageId: 'home' };
const templateUrl = `http://localhost/api/v1/sites/${SITE}/containers/template/content-type-articles/blocks`;
const templateParams = { siteId: SITE, kind: 'template', id: 'content-type-articles' };

type UnknownBody = { error: string; code: string; unknown_fields: Array<{ path: string; key: string; block_type: string; suggestions: string[] }> };

async function templateTree(): Promise<Block[]> {
  return (await (await store()).getDoc<{ blocks: Block[] }>(paths.pageTemplate(ORG, SITE, 'content-type-articles', MAIN_VERSION_ID)))!.blocks;
}

describe('update_block rejects keys no field declares', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('points a post_card key on a repeater at item_overrides and writes nothing', async () => {
    const { token } = await setup();
    await seedTemplate([relatedList()]);
    const res = await call(containerBlocks(), 'PATCH', templateUrl, templateParams, token, {
      block_id: 'related-list', data: { placeholder_background: '#f3f4f6', limit: 3 },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as UnknownBody;
    expect(body.code).toBe('unknown_field');
    expect(body.error).toContain('Did you mean item_overrides.placeholder_background?');
    expect(body.unknown_fields).toEqual([expect.objectContaining({
      path: 'data.placeholder_background', key: 'placeholder_background', block_type: 'core/repeater',
      suggestions: ['item_overrides.placeholder_background'],
    })]);
    // Nothing of the write landed, the valid key included.
    expect((await templateTree())[0]!.data).toEqual(relatedList().data);

    const fixed = await call(containerBlocks(), 'PATCH', templateUrl, templateParams, token, {
      block_id: 'related-list', data: { item_overrides: { placeholder_background: '#f3f4f6' } },
    });
    expect(fixed.status).toBe(200);
    expect((await templateTree())[0]!.data.item_overrides).toEqual({ placeholder_background: '#f3f4f6' });
  });

  it('removes a key with null, including one stored by mistake', async () => {
    const { token } = await setup();
    await seedTemplate([relatedList({ placeholder_background: null, limit: 6 })]);
    const res = await call(containerBlocks(), 'PATCH', templateUrl, templateParams, token, {
      block_id: 'related-list', data: { placeholder_background: null, limit: null, cols: 2 },
    });
    expect(res.status).toBe(200);
    const data = (await templateTree())[0]!.data;
    expect(Object.hasOwn(data, 'placeholder_background')).toBe(false);
    expect(Object.hasOwn(data, 'limit')).toBe(false);
    expect(data.cols).toBe(2);
  });

  it('suggests close field names on the page route and leaves the draft unchanged', async () => {
    const { token } = await setup();
    await seedPage('home', [{ id: 'h', type: 'core/heading', data: { text: 'Hello' } }]);
    const res = await call(pageBlocks(), 'PATCH', pageUrl, pageParams, token, { block_id: 'h', data: { levle: 'h3' } });
    expect(res.status).toBe(400);
    const body = await res.json() as UnknownBody;
    expect(body.unknown_fields[0]!.suggestions).toContain('level');
    const read = await call(pageBlocks(), 'GET', pageUrl, pageParams, token);
    expect(((await read.json()) as { blocks: Block[] }).blocks[0]!.data).toEqual({ text: 'Hello' });
  });

  it('checks only the written keys, so an older stored key does not block other writes', async () => {
    const { token } = await setup();
    await seedPage('home', [{ id: 'h', type: 'core/heading', data: { text: 'Hello', legacy: true } }]);
    const res = await call(pageBlocks(), 'PATCH', pageUrl, pageParams, token, { block_id: 'h', data: { text: 'Hi' } });
    expect(res.status).toBe(200);
  });

  it('accepts what a site block type reads without declaring it', async () => {
    const { token } = await setup();
    await (await store()).setDoc(paths.blockType(ORG, SITE, 'banner', MAIN_VERSION_ID), {
      name: 'banner', label: 'Banner', category: 'content', container: false, origin: 'user', created_at: '',
      schema: [{ name: 'title', type: 'text', label: 'Title' }], template: '<div>{{title}} {{subtitle}}</div>',
    });
    await seedPage('home', [{ id: 'b', type: 'banner', data: { title: 'A' } }]);
    const ok = await call(pageBlocks(), 'PATCH', pageUrl, pageParams, token, { block_id: 'b', data: { subtitle: 'B', responsive_breakpoints: null } });
    expect(ok.status).toBe(200);
    const bad = await call(pageBlocks(), 'PATCH', pageUrl, pageParams, token, { block_id: 'b', data: { titel: 'C' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as UnknownBody).unknown_fields[0]!.suggestions).toEqual(['title']);
  });

  it('rejects data that is not an object', async () => {
    const { token } = await setup();
    await seedPage('home', [{ id: 'h', type: 'core/heading', data: { text: 'Hello' } }]);
    const res = await call(pageBlocks(), 'PATCH', pageUrl, pageParams, token, { block_id: 'h', data: ['text'] });
    expect(res.status).toBe(400);
  });
});

describe('add_block rejects keys no field declares', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('checks the inserted block and its subtree on both routes', async () => {
    const { token } = await setup();
    await seedPage('home', []);
    const nested = await call(pageBlocks(), 'POST', pageUrl, pageParams, token, {
      block: { type: 'core/section', data: {}, children: [{ type: 'core/heading', data: { text: 'A', colour: 'red' } }] },
    });
    expect(nested.status).toBe(400);
    expect(((await nested.json()) as UnknownBody).unknown_fields.map(issue => issue.path)).toEqual(['block.children[0].data.colour']);

    await seedTemplate([]);
    const alias = await call(containerBlocks(), 'POST', templateUrl, templateParams, token, {
      block: { type: 'core/testimonials', data: { items: [], rating: 5 } },
    });
    expect(alias.status).toBe(400);
    expect(((await alias.json()) as UnknownBody).unknown_fields[0]!.suggestions).toEqual(['item_overrides.rating']);
    expect(await templateTree()).toEqual([]);

    const ok = await call(containerBlocks(), 'POST', templateUrl, templateParams, token, {
      block: { type: 'core/testimonials', data: { items: [], item_overrides: { rating: 5 }, show_dots: false } },
    });
    expect(ok.status).toBe(200);
  });
});

describe('tree writes report unknown keys as warnings', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('page PATCH lands and warns', async () => {
    const { token } = await setup();
    await seedPage('home', []);
    const res = await call(import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'), 'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/home`, pageParams, token,
      { blocks: [relatedList({ placeholder_background: '#eee' })] });
    expect(res.status).toBe(200);
    const body = await res.json() as { warnings: Array<{ code: string; path: string; suggestions?: string[] }> };
    expect(body.warnings).toEqual([expect.objectContaining({
      code: 'unknown_field', path: 'blocks[0].data.placeholder_background', suggestions: ['item_overrides.placeholder_background'],
    })]);
  });

  it('working copy PUT lands and warns', async () => {
    const { token } = await setup();
    await seedPage('home', []);
    const res = await call(import('../../pages/api/v1/sites/[siteId]/working-copy/[...target]'), 'PUT',
      `http://localhost/api/v1/sites/${SITE}/working-copy/page/home`, { siteId: SITE, target: 'page/home' }, token,
      { fields: { blocks: [{ id: 'h', type: 'core/heading', data: { text: 'A', levle: 'h2' } }] } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; warnings: Array<{ code: string; suggestions?: string[] }> };
    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([expect.objectContaining({ code: 'unknown_field', suggestions: expect.arrayContaining(['level']) })]);
  });

  it('batch-write warns per entry', async () => {
    const { token } = await setup();
    await seedPage('home', []);
    const res = await call(import('../../pages/api/v1/sites/[siteId]/pages/batch-write'), 'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/batch-write`, { siteId: SITE }, token,
      [{ page_id: 'home', patch: { blocks: [{ id: 'h', type: 'core/heading', data: { text: 'A', colour: 'red' } }] } }]);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ ok: boolean; warnings?: Array<{ code: string }> }> };
    expect(body.results[0]!.ok).toBe(true);
    expect(body.results[0]!.warnings?.map(warning => warning.code)).toEqual(['unknown_field']);
  });
});
