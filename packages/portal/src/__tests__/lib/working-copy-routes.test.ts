// /api/sites/{siteId}/working-copy/* + working-copy mode on the blocks route.
//
// The contract under test:
//   - PUT whitelists fields per kind (status can NEVER enter a working copy)
//   - PUT 404s for missing pages/items but allows create-on-write partials
//   - blocks mutations with working_copy leave the canonical page untouched
//   - the editor preview overlays working copies; the plain render does not

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { CollectionDef, Page, Site, SiteVersion, WorkingCopy } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  vi.doMock('../../lib/access', async () => {
    const actual = await vi.importActual<typeof import('../../lib/access')>('../../lib/access');
    return {
      ...actual,
      requireSiteAccess: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: { orgId: ORG, userId: 'u1', email: 'test@example.com' },
          site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', status: 'live', created_at: '' },
          versionId: MAIN_VERSION_ID,
          owner_org_id: ORG,
          permission: 'admin' as const,
        },
      })),
    };
  });
}

async function seedPage(id: string, over: Partial<Page> = {}): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, status: 'published', content_mode: 'blocks',
    blocks: [], html_content: '', ...over,
  });
}

type Handlers = Partial<Record<'GET' | 'PUT' | 'DELETE' | 'POST' | 'PATCH', APIRoute>>;

async function callWc(
  method: 'GET' | 'PUT' | 'DELETE',
  target: string,
  body?: unknown,
): Promise<Response> {
  const mod = (await import('../../pages/api/sites/[siteId]/working-copy/[...target]')) as Handlers;
  const handler = mod[method]!;
  const req = new Request(`http://localhost/api/sites/${SITE}/working-copy/${target}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return handler({
    request: req,
    params: { siteId: SITE, target },
    cookies: { get: () => undefined } as any,
    locals: {} as any,
  } as any) as Promise<Response>;
}

async function callBlocks(
  method: 'POST' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<Response> {
  const mod = (await import('../../pages/api/sites/[siteId]/pages/[pageId]/blocks')) as Handlers;
  const handler = mod[method]!;
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return handler({
    request: req,
    params: { siteId: SITE, pageId: 'home' },
    cookies: { get: () => undefined } as any,
    locals: {} as any,
  } as any) as Promise<Response>;
}

async function readWc(key: string): Promise<WorkingCopy | null> {
  const { getStore } = await import('../../lib/datastore');
  return (await getStore().getDoc<WorkingCopy>(
    paths.workingCopy(ORG, SITE, key, MAIN_VERSION_ID),
  )) ?? null;
}

describe('working-copy routes', () => {
  beforeEach(async () => { await setup(); });

  it('PUT stores whitelisted page fields and strips status + unknown fields', async () => {
    await seedPage('home');
    const res = await callWc('PUT', 'page/home', {
      fields: { title: 'Nytt', status: 'published', evil_field: 'x', date_updated: '1999-01-01' },
    });
    expect(res.status).toBe(200);
    const wc = await readWc('page--home');
    expect(wc?.fields).toEqual({ title: 'Nytt' });
  });

  it('PUT 404s for a page that does not exist', async () => {
    const res = await callWc('PUT', 'page/missing', { fields: { title: 'x' } });
    expect(res.status).toBe(404);
  });

  it('PUT allows a partial working copy before the partial exists (create-on-write)', async () => {
    const res = await callWc('PUT', 'partial/header', { fields: { html_content: '<nav></nav>' } });
    expect(res.status).toBe(200);
    expect((await readWc('partial--header'))?.fields.html_content).toBe('<nav></nav>');
  });

  it('PUT whitelists item fields against the collection schema', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.collection(ORG, SITE, 'blog', MAIN_VERSION_ID), {
      name: 'blog', label_singular: 'Post', label_plural: 'Posts',
      fields: [{ name: 'title', type: 'text', label: 'Title' }],
    } as Partial<CollectionDef>);
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'blog', 'p1', MAIN_VERSION_ID), {
      title: 'Old', status: 'published',
    });
    const res = await callWc('PUT', 'item/blog/p1', {
      fields: { title: 'New', status: 'draft', not_in_schema: 1 },
    });
    expect(res.status).toBe(200);
    expect((await readWc('item--blog--p1'))?.fields).toEqual({ title: 'New' });
  });

  it('GET returns the copy, DELETE discards it', async () => {
    await seedPage('home');
    await callWc('PUT', 'page/home', { fields: { title: 'Nytt' } });
    const got = await (await callWc('GET', 'page/home')).json() as { working_copy: WorkingCopy | null };
    expect(got.working_copy?.fields.title).toBe('Nytt');
    await callWc('DELETE', 'page/home');
    const after = await (await callWc('GET', 'page/home')).json() as { working_copy: WorkingCopy | null };
    expect(after.working_copy).toBeNull();
  });

  it('rejects a malformed target', async () => {
    expect((await callWc('PUT', 'bogus', { fields: {} })).status).toBe(400);
    expect((await callWc('PUT', 'item/blog', { fields: {} })).status).toBe(400);
  });

  it('blocks mutations leave the canonical page untouched until commit', async () => {
    await seedPage('home');
    const res = await callBlocks(
      'POST',
      `http://localhost/api/sites/${SITE}/pages/home/blocks?working_copy=1`,
      { block: { type: 'core/prose', data: { html: 'Hej' } }, working_copy: true },
    );
    expect(res.status).toBe(200);
    const { blocks } = await res.json() as { blocks: unknown[] };
    expect(blocks).toHaveLength(1);

    const { getStore } = await import('../../lib/datastore');
    const canonical = await getStore().getDoc<Page>(paths.page(ORG, SITE, 'home', MAIN_VERSION_ID));
    expect(canonical?.blocks).toEqual([]);
    const wc = await readWc('page--home');
    expect((wc?.fields.blocks as unknown[]).length).toBe(1);
  });

  it('blocks mutations ALWAYS write the working copy (buffer model)', async () => {
    await seedPage('home');
    const res = await callBlocks(
      'POST',
      `http://localhost/api/sites/${SITE}/pages/home/blocks`,
      { block: { type: 'core/prose', data: { html: 'Hej' } } },
    );
    expect(res.status).toBe(200);
    const { getStore } = await import('../../lib/datastore');
    const canonical = await getStore().getDoc<Page>(paths.page(ORG, SITE, 'home', MAIN_VERSION_ID));
    expect(canonical?.blocks).toEqual([]);
    expect(((await readWc('page--home'))?.fields.blocks as unknown[]).length).toBe(1);
  });

  it('editor preview overlays the working copy; plain render does not', async () => {
    await seedPage('home', {
      blocks: [{ id: 'b1', type: 'core/prose', data: { html: 'Sparat innehåll' } }],
    });
    const { mergeWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy(
      { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID },
      { kind: 'page', id: 'home' },
      { blocks: [{ id: 'b1', type: 'core/prose', data: { html: 'Osparat utkast' } }] },
    );
    const { renderPreview } = await import('../../lib/render-preview');
    const withWc = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID, { includeWorkingCopies: true });
    const withoutWc = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(withWc).toContain('Osparat utkast');
    expect(withoutWc).toContain('Sparat innehåll');
    expect(withoutWc).not.toContain('Osparat utkast');
  });
});

describe('blocks route — duplicate_of (editor ⌘D)', () => {
  beforeEach(async () => { await setup(); });

  it('clones the block with fresh ids into the working copy, right after the original', async () => {
    await seedPage('home', {
      blocks: [
        { id: 'sec1', type: 'core/section', data: {}, children: [
          { id: 'h1', type: 'core/heading', data: { text: 'Hej' } },
        ] },
        { id: 'p1', type: 'core/prose', data: { text: '<p>x</p>' } },
      ] as never,
    });
    const res = await callBlocks(
      'POST',
      `http://localhost/api/sites/${SITE}/pages/home/blocks`,
      { duplicate_of: 'sec1' },
    );
    expect(res.status).toBe(200);
    const out = await res.json() as { added_id: string; blocks: Array<{ id: string; type: string; children?: Array<{ id: string }> }> };
    expect(out.added_id).toBeTruthy();
    expect(out.added_id).not.toBe('sec1');
    // Clone lands directly after the original, before p1.
    expect(out.blocks.map((b) => b.id)).toEqual(['sec1', out.added_id, 'p1']);
    // Subtree cloned with fresh ids.
    const copy = out.blocks[1];
    expect(copy.type).toBe('core/section');
    expect(copy.children).toHaveLength(1);
    expect(copy.children![0].id).not.toBe('h1');
    // Mutation landed in the working copy, not the canonical page.
    const { getStore } = await import('../../lib/datastore');
    const page = await getStore().getDoc<{ blocks: unknown[] }>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`);
    expect(page?.blocks).toHaveLength(2);
    const wc = await readWc('page--home');
    expect((wc?.fields?.blocks as unknown[])).toHaveLength(3);
  });

  it('404-shapes an unknown source block', async () => {
    await seedPage('home', { blocks: [] });
    const res = await callBlocks(
      'POST',
      `http://localhost/api/sites/${SITE}/pages/home/blocks`,
      { duplicate_of: 'nope' },
    );
    expect(res.status).toBe(404);
  });
});
