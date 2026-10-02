// Route tests for the cookie-authed block type routes:
//   /api/sites/{siteId}/blocks/types           (CRUD)
//   /api/sites/{siteId}/blocks/types/validate  (check without saving)
//   /api/sites/{siteId}/blocks/types/preview   (render without saving)
//   /api/sites/{siteId}/blocks/types/starters
//   /api/sites/{siteId}/blocks/types/usage
// requireSiteAccess is stubbed so the tests can vary the caller's permission.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { BLOCK_TYPE_STARTERS, MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { BlockType, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const access = { permission: 'admin' as 'read' | 'write' | 'admin' };

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  access.permission = 'admin';
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);

  // Stub requireSiteAccess so we don't have to mint a session cookie.
  // We grant access for the test site, deny for anything else.
  vi.doMock('../../lib/access', async () => {
    const actual = await vi.importActual<typeof import('../../lib/access')>('../../lib/access');
    return {
      ...actual,
      requireSiteAccess: vi.fn(async (_c: unknown, siteId: string | undefined) => {
        if (siteId !== SITE) {
          return { ok: false as const, response: actual.json({ error: 'Not found' }, 404) };
        }
        return {
          ok: true as const,
          value: {
            session: { orgId: ORG, userId: 'u1' },
            site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', status: 'live', created_at: '' },
            versionId: MAIN_VERSION_ID,
            owner_org_id: ORG,
            permission: access.permission,
          },
        };
      }),
    };
  });
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function call(route: string, method: Method, query = '', body?: unknown): Promise<Response> {
  const modules: Record<string, () => Promise<Partial<Record<Method, APIRoute>>>> = {
    types: () => import('../../pages/api/sites/[siteId]/blocks/types'),
    validate: () => import('../../pages/api/sites/[siteId]/blocks/types/validate'),
    preview: () => import('../../pages/api/sites/[siteId]/blocks/types/preview'),
    starters: () => import('../../pages/api/sites/[siteId]/blocks/types/starters'),
    usage: () => import('../../pages/api/sites/[siteId]/blocks/types/usage'),
  };
  const handler = (await modules[route]!())[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const path = route === 'types' ? 'types' : `types/${route}`;
  const req = new Request(`http://localhost/api/sites/${SITE}/blocks/${path}${query}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handler({ request: req, params: { siteId: SITE }, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}

const card = {
  name: 'my_card',
  label: 'My Card',
  category: 'content',
  container: false,
  schema: [{ name: 'title', type: 'text', label: 'Title' }],
  template: '<div>{{title}}</div>',
  styles: '.x{color:red}',
  script: 'console.log("hi")',
};

describe('BlockType CRUD via /api/sites/{id}/blocks/types', () => {
  beforeEach(async () => { await setup(); });

  it('POST creates a new BlockType with origin=user, id = name and scoped CSS', async () => {
    const res = await call('types', 'POST', '', card);
    expect(res.status).toBe(200);
    const body = await res.json() as { block_type: BlockType & { styles_compiled: string }; warnings: unknown[] };
    expect(body.block_type.id).toBe('my_card');
    expect(body.block_type.origin).toBe('user');
    expect(body.block_type.css_scope).toBe('block');
    expect(body.block_type.styles_compiled).toContain('[data-block="my_card"]');
    // A portal admin is the trusted author of block scripts.
    expect(body.block_type.script).toBe('console.log("hi")');
    expect(body.warnings).toEqual([]);
  });

  it('GET lists them', async () => {
    await call('types', 'POST', '', card);
    const list = await call('types', 'GET');
    expect(list.status).toBe(200);
    const body = await list.json() as { block_types: BlockType[] };
    expect(body.block_types.some((t) => t.id === 'my_card')).toBe(true);
  });

  it('PATCH updates a field', async () => {
    await call('types', 'POST', '', card);
    const res = await call('types', 'PATCH', '?id=my_card', { label: 'P-updated', template: '<p>{{title}}</p>' });
    expect(res.status).toBe(200);
    const body = await res.json() as { block_type: BlockType };
    expect(body.block_type.label).toBe('P-updated');
    expect(body.block_type.template).toBe('<p>{{title}}</p>');
  });

  it('PATCH ignores server-managed properties sent back from a read', async () => {
    const created = await (await call('types', 'POST', '', card)).json() as { block_type: BlockType };
    const res = await call('types', 'PATCH', '?id=my_card', { ...created.block_type, label: 'Round trip', origin: 'ai' });
    expect(res.status).toBe(200);
    const body = await res.json() as { block_type: BlockType };
    expect(body.block_type.label).toBe('Round trip');
    expect(body.block_type.origin).toBe('user');
  });

  it('DELETE removes the doc', async () => {
    await call('types', 'POST', '', card);
    const del = await call('types', 'DELETE', '?id=my_card');
    expect(del.status).toBe(200);
    const body = await (await call('types', 'GET')).json() as { block_types: BlockType[] };
    expect(body.block_types.some((t) => t.id === 'my_card')).toBe(false);
  });

  it('DELETE refuses a type a page uses', async () => {
    await call('types', 'POST', '', card);
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
      title: 'Home', slug: 'home', status: 'published', content_mode: 'blocks', blocks: [{ id: 'a', type: 'my_card', data: {} }],
    });
    const del = await call('types', 'DELETE', '?id=my_card');
    expect(del.status).toBe(409);
    const body = await del.json() as { usage: { pages: Array<{ page_id: string }> } };
    expect(body.usage.pages.map(p => p.page_id)).toEqual(['home']);
  });

  it('answers 409 for a name that exists', async () => {
    await call('types', 'POST', '', card);
    expect((await call('types', 'POST', '', card)).status).toBe(409);
  });

  it('rejects an invalid definition with every problem and its path', async () => {
    const res = await call('types', 'POST', '', {
      name: 'Bad Name!', label: 'X', category: 'nope', container: false,
      schema: [{ name: 'title', type: 'text', label: 'T' }], template: '<p>{{titel}}</p>', extra: 1,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; problems: Array<{ severity: string; path: string; message: string }> };
    expect(body.error).toBeTruthy();
    expect(body.problems.map(p => p.path)).toEqual(expect.arrayContaining(['/name', '/category', '/extra']));
  });

  it('requires admin permission to create, change and delete; editors may still read', async () => {
    await call('types', 'POST', '', card);
    access.permission = 'write';
    expect((await call('types', 'POST', '', { ...card, name: 'other' })).status).toBe(403);
    expect((await call('types', 'PATCH', '?id=my_card', { label: 'x' })).status).toBe(403);
    expect((await call('types', 'DELETE', '?id=my_card')).status).toBe(403);
    expect((await call('types', 'GET')).status).toBe(200);
  });
});

describe('validate, preview, starters and usage session routes', () => {
  beforeEach(async () => { await setup(); });

  it('validate reports problems without saving; with type_id it checks a patch', async () => {
    const res = await call('validate', 'POST', '', { name: 'x', label: 'X', schema: [{ name: 'a', type: 'text', label: 'A' }], template: '{{#each a}}' });
    const body = await res.json() as { ok: boolean; problems: Array<{ path: string; line?: number }> };
    expect(body.ok).toBe(false);
    expect(body.problems[0]).toMatchObject({ path: '/template', line: 1 });
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(`${paths.blockTypes(ORG, SITE, MAIN_VERSION_ID)}/x`)).toBeNull();

    await call('types', 'POST', '', card);
    const patch = await (await call('validate', 'POST', '?type_id=my_card', { label: 'Fine' })).json() as { ok: boolean; merged: BlockType };
    expect(patch.ok).toBe(true);
    expect(patch.merged.label).toBe('Fine');
    expect(patch.merged.template).toBe(card.template);
  });

  it('editors may validate and preview (nothing is written)', async () => {
    access.permission = 'write';
    const starter = BLOCK_TYPE_STARTERS[0]!.definition;
    expect((await call('validate', 'POST', '', starter)).status).toBe(200);
    const preview = await (await call('preview', 'POST', '', { definition: starter })).json() as { ok: boolean };
    expect(preview.ok).toBe(true);
  });

  it('preview renders an unsaved composed type with sample data, scoped CSS and the site theme', async () => {
    const starter = BLOCK_TYPE_STARTERS[0]!.definition;
    const res = await call('preview', 'POST', '', { definition: { ...starter, styles: ':scope { gap: 2rem }' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; html: string; css: string; document: string; data: { items: unknown[] }; problems: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.html).toContain(`data-block="${starter.name}"`);
    expect(body.html).not.toContain('{{');
    expect(body.data.items.length).toBeGreaterThan(0);
    expect(body.css).toContain(`[data-block="${starter.name}"]`);
    expect(body.document).toContain('<!doctype html>');
    expect(body.document).toContain(body.css.slice(0, 40));
  });

  it('starters lists the built-in starting points', async () => {
    const body = await (await call('starters', 'GET')).json() as { starters: Array<{ id: string }> };
    expect(body.starters.map(s => s.id)).toEqual(BLOCK_TYPE_STARTERS.map(s => s.id));
  });

  it('usage lists pages, drafts and other block types', async () => {
    await call('types', 'POST', '', card);
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
      title: 'Home', slug: 'home', status: 'published', content_mode: 'blocks', blocks: [{ id: 'a', type: 'my_card', data: {} }],
    });
    const body = await (await call('usage', 'GET', '?id=my_card')).json() as { total: number; pages: Array<{ page_id: string; sources: string[] }> };
    expect(body.total).toBe(1);
    expect(body.pages).toEqual([expect.objectContaining({ page_id: 'home', sources: ['saved'] })]);
  });
});
