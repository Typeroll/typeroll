// Select values outside their options through the v1 write routes.
//
// From Moveria (moveria-nl): PATCH /pages/{id} saved a core/rich_heading with
// `level: 2` (a number) instead of "h2" and answered 200; the heading then
// rendered as a <div>. New or changed select values are now refused with 400
// `invalid_field_value`; a value the draft already holds stays editable.

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

const pageRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]');
const pageBlocks = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index');
const pageResponsive = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/responsive');
const batchWrite = () => import('../../pages/api/v1/sites/[siteId]/pages/batch-write');
const pageUrl = `http://localhost/api/v1/sites/${SITE}/pages/home`;
const params = { siteId: SITE, pageId: 'home' };

type InvalidBody = {
  error: string;
  code: string;
  details: { invalid_fields: Array<{ block_id?: string; block_type: string; path: string; field: string; value: unknown; allowed: string[]; message: string }> };
};

const richHeading = (data: Record<string, unknown> = {}): Block => ({ id: 'intro', type: 'core/rich_heading', data: { html: 'Verhuizen', level: 'h2', ...data } });

async function draftBlocks(token: string): Promise<Block[]> {
  const read = await call(pageBlocks(), 'GET', `${pageUrl}/blocks`, params, token);
  return ((await read.json()) as { blocks: Block[] }).blocks;
}

describe('select values outside their options', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('refuses a numeric heading level on a page PATCH, naming the block and field', async () => {
    const { token } = await setup();
    await seedPage('home', [richHeading()]);
    const res = await call(pageRoute(), 'PATCH', pageUrl, params, token, { blocks: [richHeading({ level: 2 })] });
    expect(res.status).toBe(400);
    const body = await res.json() as InvalidBody;
    expect(body.code).toBe('invalid_field_value');
    expect(body.error).toBe('core/rich_heading block intro: blocks[0].data.level is 2, but level must be one of "h1", "h2", "h3", "h4", "h5", "h6". Nothing was written.');
    expect(body.details.invalid_fields).toEqual([{
      block_id: 'intro', block_type: 'core/rich_heading', path: 'blocks[0].data.level', field: 'level', value: 2,
      allowed: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], message: expect.stringContaining('level must be one of'),
    }]);
    expect((await draftBlocks(token))[0]!.data.level).toBe('h2');
  });

  it('keeps a page with a stored legacy value editable and still warns about it', async () => {
    const { token } = await setup();
    await seedPage('home', [richHeading({ level: 2 })]);
    const res = await call(pageRoute(), 'PATCH', pageUrl, params, token, { blocks: [richHeading({ level: 2, html: 'Verhuizen naar Nederland' })] });
    expect(res.status).toBe(200);
    const body = await res.json() as { warnings?: Array<{ code: string; path: string }> };
    expect(body.warnings).toContainEqual(expect.objectContaining({ code: 'field_type_mismatch', path: 'blocks[0].data.level' }));
    expect((await draftBlocks(token))[0]!.data.html).toBe('Verhuizen naar Nederland');
    // Changing it to another invalid value is a change, and refused.
    const changed = await call(pageRoute(), 'PATCH', pageUrl, params, token, { blocks: [richHeading({ level: 3 })] });
    expect(changed.status).toBe(400);
    // Fixing it is always possible.
    const fixed = await call(pageRoute(), 'PATCH', pageUrl, params, token, { blocks: [richHeading({ level: 'h2' })] });
    expect(fixed.status).toBe(200);
  });

  it('refuses a block without an id in a whole-tree write', async () => {
    const { token } = await setup();
    await seedPage('home', []);
    const res = await call(pageRoute(), 'PATCH', pageUrl, params, token, { blocks: [{ type: 'core/heading', data: { text: 'Hi', align: { mobile: 'middle' } } }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as InvalidBody).details.invalid_fields[0]).toMatchObject({ path: 'blocks[0].data.align.mobile', field: 'align', value: 'middle' });
  });

  it('refuses per entry in a batch write', async () => {
    const { token } = await setup();
    await seedPage('home', [richHeading()]);
    const res = await call(batchWrite(), 'POST', `http://localhost/api/v1/sites/${SITE}/pages/batch-write`, { siteId: SITE }, token, [
      { page_id: 'home', patch: { blocks: [richHeading({ level: 2 })] } },
    ]);
    const body = await res.json() as { results: Array<{ ok: boolean; code?: string; details?: InvalidBody['details'] }> };
    expect(body.results[0]).toMatchObject({ ok: false, code: 'invalid_field_value' });
    expect(body.results[0]!.details!.invalid_fields[0]!.field).toBe('level');
  });

  it('refuses update_block, add_block and responsive writes that set one', async () => {
    const { token } = await setup();
    await seedPage('home', [richHeading()]);
    const update = await call(pageBlocks(), 'PATCH', `${pageUrl}/blocks`, params, token, { block_id: 'intro', data: { level: 2 } });
    expect(update.status).toBe(400);
    expect(((await update.json()) as InvalidBody).details.invalid_fields[0]).toMatchObject({ block_id: 'intro', path: 'block.data.level', value: 2 });

    const add = await call(pageBlocks(), 'POST', `${pageUrl}/blocks`, params, token, { block: { type: 'core/rich_heading', data: { html: 'x', level: 3 } } });
    expect(add.status).toBe(400);
    expect(((await add.json()) as InvalidBody).details.invalid_fields[0]).toMatchObject({ path: 'block.data.level', value: 3 });

    const responsive = await call(pageResponsive(), 'POST', `${pageUrl}/blocks/responsive`, params, token, { block_id: 'intro', field: 'align', value: { mobile: 'middle' } });
    expect(responsive.status).toBe(400);
    expect(((await responsive.json()) as InvalidBody).details.invalid_fields[0]).toMatchObject({ path: 'block.data.align.mobile', value: 'middle' });

    const routes = await call(pageBlocks(), 'PATCH', `${pageUrl}/blocks`, params, token, { block_id: 'intro', route_overrides: { home: { data_overrides: { level: 'h7' } } } });
    expect(routes.status).toBe(400);
    expect(((await routes.json()) as InvalidBody).details.invalid_fields[0]).toMatchObject({ path: 'block.route_overrides.home.data_overrides.level' });

    expect(await draftBlocks(token)).toEqual([richHeading()]);
  });

  it('lets update_block change other fields of a block with a legacy value', async () => {
    const { token } = await setup();
    await seedPage('home', [richHeading({ level: 2 })]);
    const res = await call(pageBlocks(), 'PATCH', `${pageUrl}/blocks`, params, token, { block_id: 'intro', data: { html: 'Nieuw' } });
    expect(res.status).toBe(200);
    expect((await draftBlocks(token))[0]!.data).toMatchObject({ html: 'Nieuw', level: 2 });
  });
});
