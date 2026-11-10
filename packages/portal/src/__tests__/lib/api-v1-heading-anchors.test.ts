// Published heading ids that a write changes, through the v1 write routes.
//
// From Moveria: a heading's id is generated from its text unless anchor_id is
// set, so editing the text of a published heading silently broke inbound `#`
// links. The write now answers with a `heading_anchor_changed` warning naming
// the old and the new id; rendering is unchanged.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths, type Block, type Page, type Site, type SiteVersion } from '@typeroll/shared';
import type { APIRoute } from 'astro';

const ORG = 'orgone';
const SITE = 'mysite';

async function store() {
  return (await import('../../lib/datastore')).getStore();
}

async function setup(deployed = true): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const s = await store();
  await s.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await s.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
    ...(deployed ? { last_deployed_at: new Date().toISOString() } : {}),
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com' });
  return { token };
}

async function seedPage(id: string, blocks: Block[], status: Page['status'] = 'published'): Promise<void> {
  await (await store()).setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, status, content_mode: 'blocks', blocks, html_content: '',
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
const workingCopy = () => import('../../pages/api/v1/sites/[siteId]/working-copy/[...target]');
const pageUrl = `http://localhost/api/v1/sites/${SITE}/pages/home`;
const params = { siteId: SITE, pageId: 'home' };

type Warning = { code: string; block_id?: string; block_type?: string; path: string; old_id?: string; new_id?: string; message: string };

const heading = (html: string, data: Record<string, unknown> = {}): Block => ({ id: 'kosten', type: 'core/rich_heading', data: { html, level: 'h2', ...data } });
const anchorWarnings = async (res: Response) => ((await res.json()) as { warnings?: Warning[] }).warnings?.filter(warning => warning.code === 'heading_anchor_changed') ?? [];

describe('heading_anchor_changed', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('warns with the old and new id when a page PATCH changes a published heading', async () => {
    const { token } = await setup();
    await seedPage('home', [heading('Kosten berekenen')]);
    const res = await call(pageRoute(), 'PATCH', pageUrl, params, token, { blocks: [heading('Kosten vergelijken')], save: true });
    expect(res.status).toBe(200);
    expect(await anchorWarnings(res)).toEqual([{
      code: 'heading_anchor_changed',
      block_id: 'kosten',
      block_type: 'core/rich_heading',
      path: 'blocks[0].data.anchor_id',
      old_id: 'kosten-berekenen',
      new_id: 'kosten-vergelijken',
      message: 'A heading in core/rich_heading block kosten is published with the id "kosten-berekenen" and will get "kosten-vergelijken" (an id without anchor_id follows the heading text), so links to #kosten-berekenen stop working. Set blocks[0].data.anchor_id to "kosten-berekenen" to keep them.',
    }]);
    // Following the hint keeps the id: no warning.
    const kept = await call(pageRoute(), 'PATCH', pageUrl, params, token, { blocks: [heading('Kosten vergelijken', { anchor_id: 'kosten-berekenen' })] });
    expect(await anchorWarnings(kept)).toEqual([]);
  });

  it('warns once, on the write that changes it', async () => {
    const { token } = await setup();
    await seedPage('home', [heading('Kosten berekenen'), { id: 'p', type: 'core/prose', data: { html: '<p>x</p>' } }]);
    const first = await call(pageBlocks(), 'PATCH', `${pageUrl}/blocks`, params, token, { block_id: 'kosten', data: { html: 'Kosten vergelijken' } });
    expect(first.status).toBe(200);
    expect((await anchorWarnings(first)).map(warning => [warning.old_id, warning.new_id, warning.path])).toEqual([['kosten-berekenen', 'kosten-vergelijken', 'blocks[0].data.anchor_id']]);
    const unrelated = await call(pageBlocks(), 'PATCH', `${pageUrl}/blocks`, params, token, { block_id: 'p', data: { html: '<p>y</p>' } });
    expect(await anchorWarnings(unrelated)).toEqual([]);
  });

  it('warns on a working copy write and for headings in prose', async () => {
    const { token } = await setup();
    await seedPage('home', [{ id: 'p', type: 'core/prose', data: { html: '<h2>Prijzen</h2><p>x</p>' } }]);
    const res = await call(workingCopy(), 'PUT', `http://localhost/api/v1/sites/${SITE}/working-copy/page/home`, { siteId: SITE, target: 'page/home' }, token, {
      fields: { blocks: [{ id: 'p', type: 'core/prose', data: { html: '<h2>Tarieven</h2><p>x</p>' } }] },
    });
    expect(res.status).toBe(200);
    expect(await anchorWarnings(res)).toEqual([expect.objectContaining({ block_id: 'p', path: 'blocks[0].data.html', old_id: 'prijzen', new_id: 'tarieven' })]);
  });

  it('is quiet for a draft page and for a site that was never published', async () => {
    const draft = await setup();
    await seedPage('home', [heading('Kosten berekenen')], 'draft');
    expect(await anchorWarnings(await call(pageRoute(), 'PATCH', pageUrl, params, draft.token, { blocks: [heading('Nieuw')] }))).toEqual([]);

    await resetDatastore();
    const unpublished = await setup(false);
    await seedPage('home', [heading('Kosten berekenen')]);
    expect(await anchorWarnings(await call(pageRoute(), 'PATCH', pageUrl, params, unpublished.token, { blocks: [heading('Nieuw')] }))).toEqual([]);
  });
});
