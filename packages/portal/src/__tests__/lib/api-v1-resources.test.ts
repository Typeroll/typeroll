// Tests for partials, block-types, page-blocks, and collections endpoints.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { CollectionDef, Site, SiteVersion } from '@typeroll/shared';

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

async function seedCollection(name: string, def: Partial<CollectionDef> = {}): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.collection(ORG, SITE, name, MAIN_VERSION_ID), {
    name,
    label_singular: def.label_singular ?? name,
    label_plural: def.label_plural ?? `${name}s`,
    icon: def.icon ?? '📄',
    fields: def.fields ?? [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'body', label: 'Body', type: 'richtext' },
    ],
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

describe('collections endpoints', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('GET / lists collections with their schemas', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/collections`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { collections: Array<{ name: string; fields: Array<{ name: string }> }> };
    expect(body.collections[0].name).toBe('blog');
    expect(body.collections[0].fields.map((f) => f.name)).toContain('title');
  });

  it('POST creates a collection and stamps a starter item_template_blocks tree', async () => {
    const { token } = await setup();
    const postRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: {
          name: 'press',
          label_singular: 'Press release',
          label_plural: 'Press releases',
          template_kind: 'blog',
          fields: [
            { name: 'title', type: 'text', label: 'Title', required: true },
            { name: 'body', type: 'richtext', label: 'Body' },
            { name: 'published_at', type: 'date', label: 'Published at' },
            { name: 'featured_image', type: 'image', label: 'Featured image' },
          ],
        },
      },
    );
    expect(postRes.status).toBe(201);
    const body = await postRes.json() as {
      collection: { name: string; item_template_blocks?: Array<{ type: string }>; renders_via_blocks: boolean }
    };
    expect(body.collection.name).toBe('press');
    expect(body.collection.renders_via_blocks).toBe(true);
    const types = body.collection.item_template_blocks?.map((b) => b.type) ?? [];
    expect(types).toContain('template/item_title');
    expect(types).toContain('template/item_body');
    expect(types).toContain('template/item_image');
  });

  it('POST infers the starter kind from fields when template_kind is omitted', async () => {
    const { token } = await setup();
    const postRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: {
          name: 'people',
          label_singular: 'Person',
          label_plural: 'People',
          // No template_kind — inference should pick 'team' from role + photo.
          fields: [
            { name: 'name', type: 'text', label: 'Name', required: true },
            { name: 'role', type: 'text', label: 'Role' },
            { name: 'photo', type: 'image', label: 'Photo' },
            { name: 'bio', type: 'textarea', label: 'Bio' },
          ],
        },
      },
    );
    expect(postRes.status).toBe(201);
    const body = await postRes.json() as {
      collection: { item_template_blocks?: Array<{ type: string; data: Record<string, unknown> }> }
    };
    const img = body.collection.item_template_blocks?.find((b) => b.type === 'template/item_image');
    // The team starter binds the image block to `photo`, not the
    // generic `image` field — confirms the team starter was chosen.
    expect((img?.data as { field?: string } | undefined)?.field).toBe('photo');
  });

  it('POST honours an explicit item_template_html (no starter applied)', async () => {
    const { token } = await setup();
    const postRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: {
          name: 'legacy',
          label_singular: 'Legacy item',
          label_plural: 'Legacy items',
          item_template_html: '<article><h1>{{title}}</h1></article>',
          fields: [{ name: 'title', type: 'text', label: 'Title', required: true }],
        },
      },
    );
    expect(postRes.status).toBe(201);
    const body = await postRes.json() as {
      collection: { item_template_html?: string; item_template_blocks?: unknown[]; renders_via_blocks: boolean }
    };
    expect(body.collection.item_template_html).toContain('{{title}}');
    expect(body.collection.renders_via_blocks).toBe(false);
    // No starter blocks when the caller opted for HTML
    expect(body.collection.item_template_blocks ?? []).toEqual([]);
  });

  it('POST + GET items round-trip, dropping fields outside the schema', async () => {
    const { token } = await setup();
    await seedCollection('blog');

    const postRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/items/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/items`,
      { siteId: SITE, name: 'blog' },
      { headers: bearer(token), body: { fields: { title: 'Hello', body: 'World', sneaky: 'ignored' } } },
    );
    expect(postRes.status).toBe(201);
    const post = await postRes.json() as { item: { id: string; title: string; sneaky?: string } };
    expect(post.item.title).toBe('Hello');
    expect(post.item.sneaky).toBeUndefined();

    const getRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/items/[itemId]'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/items/${post.item.id}`,
      { siteId: SITE, name: 'blog', itemId: post.item.id },
      { headers: bearer(token) },
    );
    const got = await getRes.json() as { item: { title: string; body: string } };
    expect(got.item.title).toBe('Hello');
    expect(got.item.body).toBe('World');
  });

  it('PATCH only writes schema-known fields', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'blog', 'i1', MAIN_VERSION_ID), {
      title: 'Old', body: 'old body', status: 'draft',
    });

    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/items/[itemId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/items/i1`,
      { siteId: SITE, name: 'blog', itemId: 'i1' },
      { headers: bearer(token), body: { fields: { body: 'new body', injected: 'nope' }, save: true } },
    );
    const { vstore } = await import('../../lib/version-store');
    const item = await vstore.collectionItem(ORG, SITE, MAIN_VERSION_ID, 'blog', 'i1');
    expect((item as Record<string, unknown>).body).toBe('new body');
    expect((item as Record<string, unknown>).title).toBe('Old');
    expect((item as Record<string, unknown>).injected).toBeUndefined();
  });

  it('GET and PATCH resolve an item by its configured slug field', async () => {
    const { token } = await setup();
    await seedCollection('blog', {
      slug_field: 'slug',
      fields: [
        { name: 'slug', label: 'Slug', type: 'text' },
        { name: 'title', label: 'Title', type: 'text' },
      ],
    });
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'blog', 'opaque-id', MAIN_VERSION_ID), {
      slug: 'hello-world', title: 'Old', status: 'draft',
    });
    const route = import('../../pages/api/v1/sites/[siteId]/collections/[name]/items/[itemId]');
    const get = await callRoute(route, 'GET', `http://localhost/api/v1/sites/${SITE}/collections/blog/items/hello-world`, {
      siteId: SITE, name: 'blog', itemId: 'hello-world',
    }, { headers: bearer(token) });
    const getBody = await get.json() as { item: { id: string }; resolved_by: string; data: unknown };
    expect(getBody.item.id).toBe('opaque-id');
    expect(getBody.resolved_by).toBe('slug');
    expect(getBody.data).toBeTruthy();

    const patchRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/items/[itemId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/items/hello-world`,
      { siteId: SITE, name: 'blog', itemId: 'hello-world' },
      { headers: bearer(token), body: { patch: { title: 'New' }, save: true } },
    );
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).item.title).toBe('New');
  });

  it('batch-read returns found/not-found per id', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'blog', 'i1', MAIN_VERSION_ID), { title: 'one' });
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'blog', 'i2', MAIN_VERSION_ID), { title: 'two' });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/items/batch-read'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/items/batch-read`,
      { siteId: SITE, name: 'blog' },
      { headers: bearer(token), body: { item_ids: ['i1', 'i2', 'nope'] } },
    );
    const body = await res.json() as { items: Array<{ item_id: string; found: boolean }> };
    expect(body.items.find((i) => i.item_id === 'i1')?.found).toBe(true);
    expect(body.items.find((i) => i.item_id === 'nope')?.found).toBe(false);
  });

  it('DELETE removes the item', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'blog', 'i1', MAIN_VERSION_ID), { title: 'x' });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/items/[itemId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/items/i1`,
      { siteId: SITE, name: 'blog', itemId: 'i1' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);

    const { vstore } = await import('../../lib/version-store');
    expect(await vstore.collectionItem(ORG, SITE, MAIN_VERSION_ID, 'blog', 'i1')).toBeNull();
  });
});

describe('collection schema CRUD', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('accepts the MCP-shaped { patch } payload and returns the data envelope', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    const response = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/collections/blog`,
      { siteId: SITE, name: 'blog' },
      { headers: bearer(token), body: { patch: { label_plural: 'Articles' } } },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { collection: { label_plural: string }; data: { collection: unknown } };
    expect(body.collection.label_plural).toBe('Articles');
    expect(body.data.collection).toEqual(body.collection);
  });

  it('POST / creates a collection with routing fields, default route_template applied', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: {
          name: 'restaurants',
          label_singular: 'Restaurant',
          label_plural: 'Restaurants',
          fields: [
            { name: 'title', label: 'Name', type: 'text', required: true },
            { name: 'slug', label: 'Slug', type: 'text', required: true },
            { name: 'cuisine', label: 'Cuisine', type: 'text' },
          ],
        },
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { collection: { name: string; route_template: string } };
    expect(body.collection.name).toBe('restaurants');
    expect(body.collection.route_template).toBe('/restaurants/{slug}');
  });

  it('POST / honors explicit route_template (including empty string)', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: {
          name: 'tags',
          label_singular: 'Tag',
          label_plural: 'Tags',
          fields: [{ name: 'title', label: 'Name', type: 'text' }],
          route_template: '',
        },
      },
    );
    const body = await res.json() as { collection: { route_template: string } };
    expect(body.collection.route_template).toBe('');
  });

  it('POST / sanitizes item_template_html', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: {
          name: 'restaurants',
          label_singular: 'Restaurant',
          label_plural: 'Restaurants',
          fields: [{ name: 'title', label: 'Name', type: 'text' }],
          item_template_html: '<h1>{{title}}</h1><script>alert(1)</script>',
        },
      },
    );
    const body = await res.json() as { collection: { item_template_html: string } };
    expect(body.collection.item_template_html).toContain('{{title}}');
    expect(body.collection.item_template_html).not.toContain('<script');
  });

  it('POST / rejects malformed names, duplicate names', async () => {
    const { token } = await setup();
    await seedCollection('blog');

    const bad = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections`,
      { siteId: SITE },
      { headers: bearer(token), body: { name: 'Bad-Name', label_singular: 'x', label_plural: 'x', fields: [{ name: 'a', label: 'A', type: 'text' }] } },
    );
    expect(bad.status).toBe(400);

    const dup = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections`,
      { siteId: SITE },
      { headers: bearer(token), body: { name: 'blog', label_singular: 'x', label_plural: 'x', fields: [{ name: 'a', label: 'A', type: 'text' }] } },
    );
    expect(dup.status).toBe(409);
  });

  it('PATCH /{name} updates the schema', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/collections/blog`,
      { siteId: SITE, name: 'blog' },
      { headers: bearer(token), body: { route_template: '/news/{slug}', label_plural: 'News' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { collection: { route_template: string; label_plural: string } };
    expect(body.collection.route_template).toBe('/news/{slug}');
    expect(body.collection.label_plural).toBe('News');
  });

  it('DELETE /{name} refuses without confirm, succeeds with confirm + drops items', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'blog', 'i1', MAIN_VERSION_ID), { title: 'x' });

    const noConfirm = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/index'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/collections/blog`,
      { siteId: SITE, name: 'blog' },
      { headers: bearer(token) },
    );
    expect(noConfirm.status).toBe(400);

    const withConfirm = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/index'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/collections/blog?confirm=true`,
      { siteId: SITE, name: 'blog' },
      { headers: bearer(token) },
    );
    expect(withConfirm.status).toBe(200);
    const r = await withConfirm.json() as { ok: boolean; deleted_items: number };
    expect(r.ok).toBe(true);
    expect(r.deleted_items).toBe(1);

    const { vstore } = await import('../../lib/version-store');
    expect(await vstore.collection(ORG, SITE, MAIN_VERSION_ID, 'blog')).toBeNull();
    expect(await vstore.collectionItem(ORG, SITE, MAIN_VERSION_ID, 'blog', 'i1')).toBeNull();
  });
});
