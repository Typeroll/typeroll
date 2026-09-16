// Native Pages and Content Types API integration tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

const typeRoute = () => import('../../pages/api/v1/sites/[siteId]/content-types/index');
const detailRoute = () => import('../../pages/api/v1/sites/[siteId]/content-types/[name]');
const pagesRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/index');
const pageRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]');
const definition = () => ({ name: 'articles', label_singular: 'Article', label_plural: 'Articles', route_template: '/articles/{slug}', fields: [
  { name: 'summary', label: 'Summary', type: 'text' }, { name: 'rank', label: 'Rank', type: 'number', default: 1 },
  { name: 'related', label: 'Related pages', type: 'page_ref_list' },
] });
const root = 'http://local/api/v1/sites/mysite';
async function createType(token: string, body: Record<string, unknown> = definition()) { return callRoute(typeRoute(), 'POST', `${root}/content-types`, { siteId: SITE }, { headers: bearer(token), body }); }
async function createPage(token: string, body: Record<string, unknown> = {}) { return callRoute(pagesRoute(), 'POST', `${root}/pages`, { siteId: SITE }, { headers: bearer(token), body: { title: 'First', content_type: 'articles', fields: { summary: 'Summary' }, ...body } }); }

describe('content types and native Pages', () => {
  let token: string;
  beforeEach(async () => { ({ token } = await setup()); });
  it('accepts directory fields and validates multiselect values on Page writes', async () => {
    const fields = [
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'website', label: 'Website', type: 'url' },
      { name: 'seasons', label: 'Seasons', type: 'multiselect', options: ['spring', 'fall'] },
    ];
    expect((await createType(token, { ...definition(), fields })).status).toBe(200);
    expect((await createPage(token, { fields: { email: 'a@example.com', website: 'https://example.com', seasons: ['spring', 'fall'] } })).status).toBe(201);
    for (const seasons of ['spring', ['unknown'], ['spring', 'spring'], [42]]) {
      const result = await createPage(token, { fields: { seasons } });
      expect(result.status).toBe(400);
      expect((await result.json()).error).toContain('seasons');
    }
    expect((await createPage(token, { fields: { seasons: [] } })).status).toBe(201);
    expect((await createPage(token, { fields: { seasons: null } })).status).toBe(201);
  });
  it('explains unsupported field types and rejects malformed facet pairs before saving', async () => {
    const bad = await createType(token, { ...definition(), fields: [{ name: 'seasons', label: 'Seasons', type: 'multi_select' }] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('seasons: unsupported field type multi_select');
    const facets = [{ field: 'summary', base_path: '/summary' }, { field: 'related', base_path: '/related' }];
    for (const facet_combinations of [[{ summary: 'related' }], [['summary']], [['summary', 'missing']], [['summary', 'summary']]]) {
      expect((await createType(token, { ...definition(), facets, facet_combinations })).status).toBe(400);
    }
    expect((await createType(token, { ...definition(), facets, facet_combinations: [['summary', 'related']], schema_field_mode: 'mapped' })).status).toBe(200);
  });
  it('lists the default type without a special storage family', async () => {
    const response = await callRoute(typeRoute(), 'GET', `${root}/content-types`, { siteId: SITE }, { headers: bearer(token) });
    expect(response.status).toBe(200); expect((await response.json()).content_types[0]).toMatchObject({ id: 'page', route_template: '/{slug}' });
  });
  it('creates, reads and updates a type and rejects duplicate IDs', async () => {
    expect((await createType(token)).status).toBe(200);
    expect((await createType(token)).status).toBe(409);
    const read = await callRoute(detailRoute(), 'GET', `${root}/content-types/articles`, { siteId: SITE, name: 'articles' }, { headers: bearer(token) });
    expect((await read.json()).content_type.fields).toHaveLength(3);
    const update = await callRoute(detailRoute(), 'PATCH', `${root}/content-types/articles`, { siteId: SITE, name: 'articles' }, { headers: bearer(token), body: { label_plural: 'Guides', sort_field: 'rank', sort_dir: 'desc' } });
    expect((await update.json()).content_type).toMatchObject({ label_plural: 'Guides', sort_field: 'rank', sort_dir: 'desc' });
  });
  it.each([
    { name: 'Invalid Name' }, { route_template: 'no-leading-slash' }, { route_template: '/{unknown}' }, { route_template: '/{slug' },
    { label_singular: 42 }, { fields: [{ name: 'title', label: 'Title', type: 'text' }] },
    { fields: [{ name: 'seo_title', label: 'SEO title', type: 'text' }] },
    { fields: [{ name: 'rank', label: 'Rank', type: 'number', default: 'bad' }] },
    { fields: [{ name: 'bad', label: 'Bad', type: 'item_ref' }] },
    { fields: [{ name: 'object', label: 'Object', type: 'object', fields: 'bad' }] },
  ])('rejects malformed or obsolete definitions: %j', async patch => {
    expect((await createType(token, { ...definition(), ...patch } as never)).status).toBe(400);
  });
  it('rejects malformed JSON without a server error', async () => {
    const response = await callRoute(typeRoute(), 'POST', `${root}/content-types`, { siteId: SITE }, { headers: bearer(token), body: '{bad' });
    expect(response.status).toBe(400);
  });
  it('creates typed Pages with blocks and custom defaults and lists them together', async () => {
    await createType(token);
    const response = await createPage(token); expect(response.status).toBe(201);
    const { page } = await response.json();
    expect(page).toMatchObject({ content_type: 'articles', fields: { summary: 'Summary', rank: 1 }, content_mode: 'blocks' });
    expect(page.blocks).toHaveLength(2);
    const all = await callRoute(pagesRoute(), 'GET', `${root}/pages?content_type=articles&full=true`, { siteId: SITE }, { headers: bearer(token) });
    expect((await all.json()).pages).toHaveLength(1);
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(paths.page(ORG, SITE, page.id))).toMatchObject({ content_type: 'articles' });
  });
  it('handles URL-less pages through the same Page API', async () => {
    await createType(token, { ...definition(), route_template: '' });
    const response = await createPage(token); expect(response.status).toBe(201);
    const { page } = await response.json(); expect(page.content_type).toBe('articles');
    const read = await callRoute(pageRoute(), 'GET', `${root}/pages/${page.id}`, { siteId: SITE, pageId: page.id }, { headers: bearer(token) });
    expect(read.status).toBe(200);
  });
  it.each([{ missing: true }, { rank: 'bad' }, { related: [42] }])('rejects unknown or invalid page custom fields: %j', async fields => {
    await createType(token); expect((await createPage(token, { fields })).status).toBe(400);
  });
  it('preserves separate custom-field draft edits, saves them and records history', async () => {
    await createType(token); const { page } = await (await createPage(token)).json();
    for (const fields of [{ summary: 'Changed' }, { rank: 3 }]) {
      const response = await callRoute(pageRoute(), 'PATCH', `${root}/pages/${page.id}`, { siteId: SITE, pageId: page.id }, { headers: bearer(token), body: { fields } });
      expect(response.status).toBe(200);
    }
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(paths.page(ORG, SITE, page.id))).toMatchObject({ fields: { summary: 'Summary', rank: 1 } });
    const response = await callRoute(pageRoute(), 'PATCH', `${root}/pages/${page.id}`, { siteId: SITE, pageId: page.id }, { headers: bearer(token), body: { fields: { related: [page.id] }, save: true } });
    expect(response.status).toBe(200);
    expect(await getStore().getDoc(paths.page(ORG, SITE, page.id))).toMatchObject({ fields: { summary: 'Changed', rank: 3, related: [page.id] } });
    expect(await getStore().listDocs(paths.revisions(ORG, SITE, page.id))).toHaveLength(1);
  });
  it('preserves field authority and reports rejected writes', async () => {
    await createType(token, { ...definition(), fields: [{ name: 'managed', label: 'Managed', type: 'text', writable_by: ['app'] }] } as never);
    expect((await createPage(token, { fields: { managed: 'Unauthorized' } })).status).toBe(409);
  });
  it('refuses deleting an in-use or default type, allows an unused type', async () => {
    await createType(token); const remove = (name: string) => callRoute(detailRoute(), 'DELETE', `${root}/content-types/${name}`, { siteId: SITE, name }, { headers: bearer(token) });
    expect((await remove('page')).status).toBe(400);
    const { page } = await (await createPage(token)).json();
    expect((await remove('articles')).status).toBe(409);
    await callRoute(pageRoute(), 'DELETE', `${root}/pages/${page.id}`, { siteId: SITE, pageId: page.id }, { headers: bearer(token) });
    expect((await remove('articles')).status).toBe(200);
  });
  it('requires authentication', async () => {
    const response = await callRoute(typeRoute(), 'GET', `${root}/content-types`, { siteId: SITE });
    expect(response.status).toBe(401);
  });
});

describe('changing a Page content type through the public API', () => {
  let token: string;
  beforeEach(async () => { ({ token } = await setup()); await createType(token); });
  const changeRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/content-type');
  async function change(pageId: string, body: unknown, suffix = '') {
    return callRoute(changeRoute(), 'POST', `${root}/pages/${pageId}/content-type${suffix}`, { siteId: SITE, pageId }, { headers: bearer(token), body });
  }
  it('keeps the same Page ID, blocks, publication state and public URL while recording history', async () => {
    const response = await createPage(token, { status: 'published', blocks: [{ id: 'body', type: 'core/prose', data: { html: '<p>Original</p>' } }] });
    const created = (await response.json()).page;
    expect((await change(created.id, { content_type: 'page' })).status).toBe(400);
    const moved = await change(created.id, { content_type: 'page', fields: {} });
    expect(moved.status).toBe(200);
    const page = (await moved.json()).page;
    expect(page).toMatchObject({ id: created.id, content_type: 'page', fields: {}, status: 'published', path: '/articles/first', blocks: created.blocks });
    const { getStore } = await import('../../lib/datastore');
    const history = await getStore().listDocs<any>(paths.revisions(ORG, SITE, created.id, MAIN_VERSION_ID));
    expect(history).toHaveLength(1);
    expect(history[0].doc.fields.summary).toBe('Summary');
    expect(history[0].doc.content_type).toBe('articles');
  });
  it('requires new required fields on type changes and keeps the page intact after rejection', async () => {
    const { page } = await (await createPage(token)).json();
    await createType(token, { ...definition(), name: 'required-fields', fields: [{ name: 'summary', label: 'Summary', type: 'text', required: true }] });
    expect((await change(page.id, { content_type: 'required-fields', fields: {} })).status).toBe(400);
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(paths.page(ORG, SITE, page.id))).toMatchObject({ content_type: 'articles' });
    expect((await change(page.id, { content_type: 'required-fields', fields: { summary: 'New summary' } })).status).toBe(200);
  });
  it('materializes an inherited Page only in the selected version', async () => {
    const created = (await (await createPage(token)).json()).page;
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.version(ORG, SITE, 'redesign'), { name: 'Redesign', kind: 'branch', base_version_id: 'main' });
    const moved = await change(created.id, { content_type: 'page', fields: {} }, '?version=redesign');
    expect(moved.status).toBe(200);
    expect((await getStore().getDoc<any>(paths.page(ORG, SITE, created.id, 'main')))?.content_type).toBe('articles');
    expect((await getStore().getDoc<any>(paths.page(ORG, SITE, created.id, 'redesign')))?.content_type).toBe('page');
  });
  it('rejects a type change while a working copy exists, without losing its fields', async () => {
    const created = (await (await createPage(token)).json()).page;
    const { mergeWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy({ orgId: ORG, siteId: SITE, versionId: 'main' }, { kind: 'page', id: created.id }, { title: 'Unsaved title' });
    const response = await change(created.id, { content_type: 'page', fields: {} });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('Save or discard');
  });
  it('rejects explicit null fields rather than silently carrying fields over', async () => {
    const created = (await (await createPage(token)).json()).page;
    expect((await change(created.id, { content_type: 'page', fields: null })).status).toBe(400);
  });
  it('preserves a concurrent edit when changing the content type', async () => {
    const created = (await (await createPage(token)).json()).page;
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    const replace = store.compareAndReplaceDoc.bind(store);
    const spy = vi.spyOn(store, 'compareAndReplaceDoc').mockImplementationOnce(async (path, expected, data) => {
      await store.updateDoc(path, { title: 'Concurrent edit' });
      return replace(path, expected, data);
    });
    try {
      expect((await change(created.id, { content_type: 'page', fields: {} })).status).toBe(409);
      expect(await store.getDoc(paths.page(ORG, SITE, created.id, 'main'))).toMatchObject({ title: 'Concurrent edit', content_type: 'articles' });
    } finally { spy.mockRestore(); }
  });
  it('cannot bypass field ownership by moving content to another type', async () => {
    const created = (await (await createPage(token)).json()).page;
    const { vstore } = await import('../../lib/version-store');
    await vstore.writeContentType(ORG, SITE, 'main', 'articles', { fields: [{ name: 'summary', type: 'text', label: 'Summary', writable_by: ['owner'] }] });
    const response = await change(created.id, { content_type: 'page', fields: {} });
    expect(response.status).toBe(409);
    expect((await vstore.page(ORG, SITE, 'main', created.id))?.content_type).toBe('articles');
  });
});


describe('native Page templates through the public API', () => {
  let token: string;
  beforeEach(async () => { ({ token } = await setup()); await createType(token); });
  const templates = () => import('../../pages/api/v1/sites/[siteId]/page-templates/index');
  const template = () => import('../../pages/api/v1/sites/[siteId]/page-templates/[templateId]');
  const create = (body: unknown) => callRoute(templates(), 'POST', `${root}/page-templates`, { siteId: SITE }, { headers: bearer(token), body });
  const detail = (method: 'GET' | 'PATCH' | 'DELETE', body?: unknown, suffix = '') => callRoute(template(), method, `${root}/page-templates/article-shell${suffix}`, { siteId: SITE, templateId: 'article-shell' }, { headers: bearer(token), body });
  it('creates a body-slot starter, assigns it to a content type, and renders Page content', async () => {
    expect((await create({ name: 'article-shell', starter: 'custom', status: 'published' })).status).toBe(200);
    expect((await create({ name: 'article-shell', starter: 'custom' })).status).toBe(409);
    await callRoute(detailRoute(), 'PATCH', `${root}/content-types/articles`, { siteId: SITE, name: 'articles' }, { headers: bearer(token), body: { template: 'article-shell' } });
    const page = (await (await createPage(token, { blocks: [{ id: 'text', type: 'core/prose', data: { html: '<p>Editable body</p>' } }] })).json()).page;
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, page.id, 'main');
    expect(html).toContain('Editable body');
    expect(html).toContain('First');
    expect((await detail('DELETE')).status).toBe(409);
  });
  it('isolates a template edit and deletion in a version', async () => {
    await create({ name: 'article-shell', starter: 'custom', label: 'Original' });
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.version(ORG, SITE, 'design'), { kind: 'branch', base_version_id: 'main' });
    expect((await detail('PATCH', { label: 'Branch layout' }, '?version=design')).status).toBe(200);
    expect((await (await detail('GET')).json()).template.label).toBe('Original');
    expect((await detail('DELETE', undefined, '?version=design')).status).toBe(200);
    expect((await detail('GET', undefined, '?version=design')).status).toBe(404);
    expect((await detail('GET')).status).toBe(200);
  });
  it('rejects malformed templates and requires authentication', async () => {
    expect((await create({ name: 'article-shell', starter: 'unknown' })).status).toBe(400);
    expect((await create({ name: 'article-shell', blocks: 'bad' })).status).toBe(400);
    expect((await callRoute(templates(), 'GET', `${root}/page-templates`, { siteId: SITE })).status).toBe(401);
  });
  it('enforces allowed templates at creation, save and definition changes', async () => {
    const { savePageTemplate, removePageTemplate } = await import('../../lib/page-template-service');
    const { saveContentType } = await import('../../lib/content-type-service');
    const ctx = { orgId: ORG, siteId: SITE, versionId: 'main' };
    for (const id of ['standard', 'wide', 'other']) await savePageTemplate(ctx, id, { label: id, status: 'published', starter: 'article' }, true);
    await saveContentType(ctx, 'articles', { template: 'standard', allowed_templates: ['standard', 'wide'] });
    expect((await createPage(token, { template: 'other' })).status).toBe(400);
    expect((await createPage(token, { sort_order: 'bad' })).status).toBe(400);
    const { page } = await (await createPage(token, { template: 'wide', sort_order: 4 })).json();
    const { mergeWorkingCopy: stageFields, filterWcFields, commitWorkingCopy } = await import('../../lib/working-copy');
    await expect(filterWcFields(ctx, { kind: 'page', id: page.id }, { template: 'other' })).rejects.toThrow('not allowed');
    await expect(removePageTemplate(ctx, 'standard')).rejects.toThrow('Choose another template');
    await expect(saveContentType(ctx, 'articles', { allowed_templates: ['standard'] })).rejects.toThrow('uses a template outside');
    await stageFields(ctx, { kind: 'page', id: page.id }, { template: null, sort_order: null }, 'test');
    await commitWorkingCopy(ctx, { kind: 'page', id: page.id }, 'test');
    const { vstore } = await import('../../lib/version-store');
    const saved = await vstore.page(ORG, SITE, 'main', page.id);
    expect(saved?.template).toBeNull(); expect(saved?.sort_order).toBeNull();
    await saveContentType(ctx, 'articles', { allowed_templates: ['standard'] });
    await expect(saveContentType(ctx, 'articles', { template: 'wide' })).rejects.toThrow('default template');
    await expect(savePageTemplate(ctx, 'standard', { applies_to: 'content_type:other' })).rejects.toThrow('another content type');
    await saveContentType(ctx, 'articles', { allowed_templates: null });
    await stageFields(ctx, { kind: 'page', id: page.id }, { template: 'wide' }, 'test');
    await saveContentType(ctx, 'articles', { allowed_templates: ['standard'] });
    await expect(commitWorkingCopy(ctx, { kind: 'page', id: page.id }, 'test')).rejects.toThrow('not allowed');
  });
  it('uses selected type sorting in paginated API responses and allows a listing override', async () => {
    const { saveContentType } = await import('../../lib/content-type-service');
    await saveContentType({ orgId: ORG, siteId: SITE, versionId: 'main' }, 'articles', { sort_field: 'rank', sort_dir: 'desc' });
    await createPage(token, { title: 'Low', fields: { rank: 2 } });
    await createPage(token, { title: 'High', fields: { rank: 50 } });
    const read = async (query: string) => (await callRoute(pagesRoute(), 'GET', `${root}/pages?content_type=articles&${query}`, { siteId: SITE }, { headers: bearer(token) })).json();
    const first = await read('limit=1'); expect(first.pages[0].title).toBe('High');
    expect((await read(`limit=1&cursor=${first.next_cursor}`)).pages[0].title).toBe('Low');
    expect((await read('sort_by=rank&sort_order=asc')).pages[0].title).toBe('Low');
  });

});
