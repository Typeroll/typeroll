// create_page must never silently move a requested address. An explicit slug
// or path that is already in use answers 409 naming the existing page; only a
// title-derived slug is numbered, and the response then carries a warning.

import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths, type Site, type SiteVersion } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'orgone';
const SITE = 'mysite';
const root = `http://localhost/api/v1/sites/${SITE}`;
const pagesRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/index');
const typesRoute = () => import('../../pages/api/v1/sites/[siteId]/content-types/index');

let token = '';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  ({ token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com' }));
});

async function call(route: Promise<Partial<Record<'POST', APIRoute>>>, url: string, body: unknown): Promise<Response> {
  const handler = (await route).POST!;
  const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return handler({ request, params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

const create = (body: Record<string, unknown>) => call(pagesRoute(), `${root}/pages`, body);

async function seedPage(id: string, doc: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, content_mode: 'html', status: 'published', html_content: '<p>seed</p>', ...doc,
  });
}

async function pageIds(): Promise<string[]> {
  const { vstore } = await import('../../lib/version-store');
  return (await vstore.pages(ORG, SITE, MAIN_VERSION_ID)).map(page => page.id).sort();
}

interface CreateBody {
  page: { id: string; slug: string; url: string | null };
  warnings?: Array<Record<string, unknown>>;
  error?: string;
  code?: string;
  details?: Record<string, unknown>;
}

describe('create_page slug conflicts', () => {
  it('creates the requested slug unchanged, without warnings, when it is free', async () => {
    const response = await create({ title: 'Thanks', slug: 'tack' });
    expect(response.status).toBe(201);
    const body = await response.json() as CreateBody;
    expect(body.page).toMatchObject({ id: 'tack', slug: 'tack', url: '/tack' });
    expect(body).not.toHaveProperty('warnings');
  });

  it('answers 409 slug_in_use with the existing page id and path for an explicit slug', async () => {
    await seedPage('tack', { title: 'Tack' });
    const response = await create({ title: 'Tack för din förfrågan', slug: 'tack' });
    expect(response.status).toBe(409);
    const body = await response.json() as CreateBody;
    expect(body.code).toBe('slug_in_use');
    expect(body.details).toEqual({ page_id: 'tack', path: '/tack' });
    expect(body.error).toContain('/tack');
    expect(await pageIds()).toEqual(['tack']);
  });

  it('treats a slug with surrounding slashes as the same address', async () => {
    await seedPage('tack', {});
    const response = await create({ title: 'Tack', slug: '/tack/' });
    expect(response.status).toBe(409);
    expect((await response.json() as CreateBody).details).toEqual({ page_id: 'tack', path: '/tack' });
  });

  it('counts draft pages as owners of their address', async () => {
    expect((await create({ title: 'Draft thanks', slug: 'tack' })).status).toBe(201);
    const response = await create({ title: 'Second thanks', slug: 'tack' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'slug_in_use', details: { page_id: 'tack', path: '/tack' } });
  });

  it('counts the address an unsaved draft will take on save', async () => {
    await seedPage('about', { title: 'About' });
    const { mergeWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy({ orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID }, { kind: 'page', id: 'about' }, { slug: 'tack' });
    const response = await create({ title: 'Tack', slug: 'tack' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'slug_in_use', details: { page_id: 'about', path: '/tack' } });
  });

  it('numbers a title-derived slug and reports the adjustment', async () => {
    await seedPage('tack', { title: 'Tack' });
    const response = await create({ title: 'Tack' });
    expect(response.status).toBe(201);
    const body = await response.json() as CreateBody;
    expect(body.page).toMatchObject({ id: 'tack-2', slug: 'tack-2', url: '/tack-2' });
    expect(body.warnings).toEqual([expect.objectContaining({
      code: 'slug_adjusted', requested: 'tack', slug: 'tack-2', path: '/tack-2', conflicting_page_id: 'tack',
    })]);
    expect(String(body.warnings![0].message)).toContain('tack-2');
  });

  it('keeps an explicit slug when only an unrelated page holds the derived id', async () => {
    // The page stored as "tack" moved to /thanks, so /tack itself is free.
    await seedPage('tack', { title: 'Thanks', slug: 'thanks' });
    const response = await create({ title: 'Tack', slug: 'tack' });
    expect(response.status).toBe(201);
    const body = await response.json() as CreateBody;
    expect(body.page).toMatchObject({ slug: 'tack', url: '/tack', id: 'tack-2' });
    expect(body).not.toHaveProperty('warnings');
  });

  it('answers path_in_use with details for an explicit path', async () => {
    expect((await create({ title: 'Summer', slug: 'sommar', path: '/erbjudanden/sommar' })).status).toBe(201);
    const response = await create({ title: 'Summer again', slug: 'sommar-2', path: '/erbjudanden/sommar' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'path_in_use', details: { page_id: 'erbjudanden_sommar', path: '/erbjudanden/sommar' } });
  });

  it('answers 409 for a second homepage with the existing homepage id', async () => {
    expect((await create({ title: 'Home', slug: '' })).status).toBe(201);
    const response = await create({ title: 'Start', slug: '' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'slug_in_use', details: { page_id: 'home', path: '/' } });
  });

  it('compares addresses through each content type route template', async () => {
    const type = await call(typesRoute(), `${root}/content-types`, { name: 'articles', label_singular: 'Article', label_plural: 'Articles', route_template: '/articles/{slug}', fields: [] });
    expect(type.ok).toBe(true);
    expect((await create({ title: 'News', content_type: 'articles', slug: 'news' })).status).toBe(201);
    // Same slug, different route: allowed.
    const page = await create({ title: 'News', slug: 'news' });
    expect(page.status).toBe(201);
    expect((await page.json() as CreateBody).page.url).toBe('/news');
    const clash = await create({ title: 'More news', content_type: 'articles', slug: 'news' });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ code: 'slug_in_use', details: { page_id: 'articles_news', path: '/articles/news' } });
    const derived = await create({ title: 'News', content_type: 'articles' });
    expect(derived.status).toBe(201);
    expect(await derived.json()).toMatchObject({ page: { slug: 'news-2', url: '/articles/news-2' }, warnings: [{ code: 'slug_adjusted', conflicting_page_id: 'articles_news' }] });
  });

  it('answers path_in_use when the route is built from fields other than the slug', async () => {
    const type = await call(typesRoute(), `${root}/content-types`, {
      name: 'offices', label_singular: 'Office', label_plural: 'Offices', route_template: '/offices/{city}',
      fields: [{ name: 'city', label: 'City', type: 'text' }],
    });
    expect(type.ok).toBe(true);
    expect((await create({ title: 'Sundsvall', content_type: 'offices', fields: { city: 'sundsvall' } })).status).toBe(201);
    const response = await create({ title: 'Sundsvall office', content_type: 'offices', fields: { city: 'sundsvall' } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'path_in_use', details: { page_id: 'offices_sundsvall', path: '/offices/sundsvall' } });
  });
});

describe('a supplied page id', () => {
  it('is kept even when a path would derive another id', async () => {
    const res = await create({ id: 'category_diy-selber-machen', title: 'DIY', path: '/category/alle-blogposts/diy-selber-machen' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { page: { id: string } }).page.id).toBe('category_diy-selber-machen');
  });
  it('answers 409 when the id is taken and 400 when it is invalid, instead of replacing it', async () => {
    await seedPage('taken', { title: 'Taken', slug: 'taken' });
    expect((await create({ id: 'taken', title: 'Other', slug: 'other' })).status).toBe(409);
    expect((await create({ id: 'has/slash', title: 'Other', slug: 'other' })).status).toBe(400);
  });
});
