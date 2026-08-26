// CRUD route tests for /api/sites/{siteId}/blocks/types. The route is
// cookie-authed; we bypass auth by stubbing requireSiteAccess via the
// shared helper used elsewhere in tests. Here we use the same approach as
// the redirects tests — direct route call with a fake locals.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { BlockType, Site, SiteVersion } from '@typeroll/shared';

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
          permission: 'admin' as const,
          },
        };
      }),
    };
  });
}

async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PATCH' | 'DELETE', APIRoute>>>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  params: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handler({
    request: req, params,
    cookies: { get: () => undefined } as any,
    locals: {} as any,
  } as any) as Promise<Response>;
}

describe('BlockType CRUD via /api/sites/{id}/blocks/types', () => {
  beforeEach(async () => { await setup(); });

  it('POST creates a new BlockType with origin=user', async () => {
    const res = await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'POST',
      `http://localhost/api/sites/${SITE}/blocks/types`,
      { siteId: SITE },
      {
        name: 'my_card',
        label: 'My Card',
        category: 'content',
        container: false,
        schema: [{ name: 'title', type: 'text', label: 'Title' }],
        template: '<div>{{title}}</div>',
        styles: '.x{color:red}',
        script: 'console.log("hi")',
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as BlockType;
    expect(body.id).toBe('my_card');
    expect(body.origin).toBe('user');
    expect(body.script).toBe('console.log("hi")');
  });

  it('GET lists them', async () => {
    await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'POST',
      `http://localhost/api/sites/${SITE}/blocks/types`,
      { siteId: SITE },
      { name: 'a', label: 'A', category: 'content', container: false, schema: [] },
    );
    const list = await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'GET',
      `http://localhost/api/sites/${SITE}/blocks/types`,
      { siteId: SITE },
    );
    expect(list.status).toBe(200);
    const body = await list.json() as { block_types: BlockType[] };
    expect(body.block_types.some((t) => t.id === 'a')).toBe(true);
  });

  it('PATCH updates a field', async () => {
    await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'POST',
      `http://localhost/api/sites/${SITE}/blocks/types`,
      { siteId: SITE },
      { name: 'p', label: 'P', category: 'content', container: false, schema: [] },
    );
    const res = await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'PATCH',
      `http://localhost/api/sites/${SITE}/blocks/types?id=p`,
      { siteId: SITE },
      { label: 'P-updated', template: '<p>{{x}}</p>' },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as BlockType;
    expect(body.label).toBe('P-updated');
    expect(body.template).toBe('<p>{{x}}</p>');
  });

  it('DELETE removes the doc', async () => {
    await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'POST',
      `http://localhost/api/sites/${SITE}/blocks/types`,
      { siteId: SITE },
      { name: 'gone', label: 'Gone', category: 'content', container: false, schema: [] },
    );
    const del = await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'DELETE',
      `http://localhost/api/sites/${SITE}/blocks/types?id=gone`,
      { siteId: SITE },
    );
    expect(del.status).toBe(200);
    const list = await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'GET',
      `http://localhost/api/sites/${SITE}/blocks/types`,
      { siteId: SITE },
    );
    const body = await list.json() as { block_types: BlockType[] };
    expect(body.block_types.some((t) => t.id === 'gone')).toBe(false);
  });

  it('rejects invalid names', async () => {
    const res = await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'POST',
      `http://localhost/api/sites/${SITE}/blocks/types`,
      { siteId: SITE },
      { name: 'Bad Name!', label: 'X', category: 'content', container: false, schema: [] },
    );
    expect(res.status).toBe(400);
  });

  it('rejects bad category', async () => {
    const res = await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'POST',
      `http://localhost/api/sites/${SITE}/blocks/types`,
      { siteId: SITE },
      { name: 'ok', label: 'X', category: 'nope', container: false, schema: [] },
    );
    expect(res.status).toBe(400);
  });

  it('rejects slots container without slot_count', async () => {
    const res = await callRoute(
      import('../../pages/api/sites/[siteId]/blocks/types'),
      'POST',
      `http://localhost/api/sites/${SITE}/blocks/types`,
      { siteId: SITE },
      { name: 'slt', label: 'X', category: 'layout', container: 'slots', schema: [] },
    );
    expect(res.status).toBe(400);
  });
});
