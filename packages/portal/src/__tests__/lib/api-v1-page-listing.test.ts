// Dynamic Page listings use saved Pages at render time; no regeneration API.
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { ContentType, Site, SiteVersion } from '@typeroll/shared';

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
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
  return { token };
}

async function seedContentType(name: string, def: Partial<ContentType> = {}): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.contentType(ORG, SITE, name, MAIN_VERSION_ID), {
    name,
    label_singular: name,
    label_plural: `${name}s`,
    fields: [{ name: 'rating', type: 'number', label: 'Rating' }],
    route_template: `/${name}/{slug}`,
    sort_field: 'title',
    sort_dir: 'asc',
    ...def,
  });
}

async function seedTypedPage(name: string, id: string, fields: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.page(ORG, SITE, id, MAIN_VERSION_ID), {
    status: 'published', content_type: name, content_mode: 'blocks', blocks: [], date_updated: '2026-01-01', ...fields,
  });
}

interface CallInit { headers?: HeadersInit; body?: unknown }
async function callRoute(
  routeImport: Promise<Partial<Record<'POST', APIRoute>>>,
  method: 'POST',
  url: string,
  params: Record<string, string>,
  init?: CallInit,
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null && typeof init.body !== 'string' ? JSON.stringify(init.body) : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

describe('native Page listings', () => {
  async function createListing(token: string, data: Record<string, unknown> = {}) {
    return callRoute(import('../../pages/api/v1/sites/[siteId]/pages/index'), 'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`, { siteId: SITE }, {
        headers: bearer(token), body: { title: 'News', slug: 'news', status: 'published', content_mode: 'blocks', blocks: [
          { id: 'heading', type: 'core/heading', data: { text: 'Latest', level: 'h1' } },
          { id: 'listing', type: 'core/page_list', data: { content_type: 'blog', sort_by: 'title', sort_order: 'asc', empty_state: '<p>Nothing published yet</p>', ...data } },
        ] },
      });
  }
  it('renders new and removed Pages without rewriting the listing Page', async () => {
    const { token } = await setup();
    await seedContentType('blog');
    expect((await createListing(token)).status).toBe(201);
    const { renderPreview } = await import('../../lib/render-preview');
    const { getStore } = await import('../../lib/datastore');
    const listingPath = paths.page(ORG, SITE, 'news');
    const original = await getStore().getDoc(listingPath);
    expect(await renderPreview(ORG, SITE, 'news', MAIN_VERSION_ID)).toContain('Nothing published yet');
    await seedTypedPage('blog', 'beta', { title: 'Beta launch', slug: 'beta' });
    await seedTypedPage('blog', 'alpha', { title: 'Alpha launch', slug: 'alpha' });
    let html = await renderPreview(ORG, SITE, 'news', MAIN_VERSION_ID);
    expect(html).toContain('href="/blog/alpha"');
    expect(html!.indexOf('Alpha launch')).toBeLessThan(html!.indexOf('Beta launch'));
    await getStore().deleteDoc(paths.page(ORG, SITE, 'alpha'));
    html = await renderPreview(ORG, SITE, 'news', MAIN_VERSION_ID);
    expect(html).not.toContain('Alpha launch');
    expect(html).toContain('Beta launch');
    expect(await getStore().getDoc(listingPath)).toEqual(original);
  });
  it('hides drafts and unlisted Pages and escapes titles', async () => {
    const { token } = await setup();
    await seedContentType('blog');
    await createListing(token);
    await seedTypedPage('blog', 'unsafe', { title: '<script>unsafe title</script>', slug: 'unsafe' });
    await seedTypedPage('blog', 'draft', { title: 'Private draft', slug: 'draft', status: 'draft' });
    await seedTypedPage('blog', 'hidden', { title: 'Unlisted title', slug: 'hidden', status: 'unlisted' });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'news', MAIN_VERSION_ID);
    expect(html).toContain('&lt;script&gt;unsafe title&lt;/script&gt;');
    expect(html).not.toContain('<script>unsafe title');
    expect(html).not.toContain('Private draft');
    expect(html).not.toContain('Unlisted title');
  });
  it('sorts custom numeric fields numerically', async () => {
    const { token } = await setup();
    await seedContentType('blog');
    await createListing(token, { sort_by: 'rating', sort_order: 'asc' });
    await seedTypedPage('blog', 'high', { title: 'High rating', slug: 'high', fields: { rating: 23 } });
    await seedTypedPage('blog', 'low', { title: 'Low rating', slug: 'low', fields: { rating: 9 } });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'news', MAIN_VERSION_ID);
    expect(html!.indexOf('Low rating')).toBeLessThan(html!.indexOf('High rating'));
  });
  it('inherits type sorting in preview and isolates a branch override', async () => {
    const { token } = await setup();
    await seedContentType('blog', { sort_field: 'rating', sort_dir: 'desc' });
    await createListing(token, { sort_by: '', sort_order: '' });
    await seedTypedPage('blog', 'high', { title: 'High rating', slug: 'high', fields: { rating: 23 } });
    await seedTypedPage('blog', 'low', { title: 'Low rating', slug: 'low', fields: { rating: 9 } });
    const { renderPreview } = await import('../../lib/render-preview');
    const { getStore } = await import('../../lib/datastore');
    const { vstore } = await import('../../lib/version-store');
    await getStore().setDoc(paths.version(ORG, SITE, 'design'), { kind: 'branch', base_version_id: 'main' });
    await vstore.writeContentType(ORG, SITE, 'design', 'blog', { sort_dir: 'asc' });
    const main = (await renderPreview(ORG, SITE, 'news', 'main'))!;
    const branch = (await renderPreview(ORG, SITE, 'news', 'design'))!;
    expect(main.indexOf('High rating')).toBeLessThan(main.indexOf('Low rating'));
    expect(branch.indexOf('Low rating')).toBeLessThan(branch.indexOf('High rating'));
  });

});
