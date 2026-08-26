// /api/sites/{siteId}/changes-since-deploy — read-time classification of
// what a redeploy would ship.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const DEPLOYED_AT = '2026-01-01T00:00:00.000Z';
const BEFORE = '2025-12-01T00:00:00.000Z';
const AFTER = '2026-02-01T00:00:00.000Z';

async function setup(withDeploy: boolean): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: BEFORE, robots_blocked: false,
    ...(withDeploy ? { last_deployed_at: DEPLOYED_AT } : {}),
  } satisfies Partial<SiteVersion>);
  vi.doMock('../../lib/access', async () => {
    const actual = await vi.importActual<typeof import('../../lib/access')>('../../lib/access');
    return {
      ...actual,
      requireSiteAccess: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: { orgId: ORG, userId: 'u1' },
          site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', status: 'live', created_at: '' },
          versionId: MAIN_VERSION_ID,
          owner_org_id: ORG,
          permission: 'admin' as const,
        },
      })),
    };
  });
}

async function call(): Promise<{
  last_deployed_at: string | null;
  never_deployed: boolean;
  total: number;
  changes: Array<{ kind: string; id: string; will_deploy: boolean; status?: string }>;
}> {
  const mod = await import('../../pages/api/sites/[siteId]/changes-since-deploy');
  const handler = mod.GET as APIRoute;
  const res = await handler({
    request: new Request(`http://localhost/api/sites/${SITE}/changes-since-deploy`),
    params: { siteId: SITE },
    cookies: { get: () => undefined } as any,
    locals: {} as any,
  } as any) as Response;
  expect(res.status).toBe(200);
  return res.json();
}

describe('changes-since-deploy', () => {
  beforeEach(async () => { await setup(true); });

  it('lists only docs written after the last deploy, newest first', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/old`, {
      title: 'Old', slug: 'old', status: 'published', content_mode: 'blocks', date_updated: BEFORE,
    });
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/fresh`, {
      title: 'Fresh', slug: 'fresh', status: 'published', content_mode: 'blocks', date_updated: AFTER,
    });
    const body = await call();
    expect(body.never_deployed).toBe(false);
    expect(body.total).toBe(1);
    expect(body.changes[0]).toMatchObject({ kind: 'page', id: 'fresh', will_deploy: true });
  });

  it('marks changed drafts as not shipping', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/wip`, {
      title: 'WIP', slug: 'wip', status: 'draft', content_mode: 'blocks', date_updated: AFTER,
    });
    const body = await call();
    expect(body.changes[0]).toMatchObject({ kind: 'page', id: 'wip', will_deploy: false, status: 'draft' });
  });

  it('includes changed partials and collection items', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.partial(ORG, SITE, 'header', MAIN_VERSION_ID), {
      name: 'Header', kind: 'header', content_mode: 'html', status: 'published',
      html_content: '<nav/>', date_updated: AFTER,
    });
    await getStore().setDoc(paths.collection(ORG, SITE, 'blog', MAIN_VERSION_ID), {
      name: 'blog', label_singular: 'Post', label_plural: 'Posts',
      fields: [{ name: 'title', type: 'text', label: 'Title' }],
    });
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'blog', 'p1', MAIN_VERSION_ID), {
      title: 'Post 1', status: 'published', updated_at: AFTER,
    });
    const body = await call();
    const kinds = body.changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(['collection_item', 'partial']);
    expect(body.changes.every((c) => c.will_deploy)).toBe(true);
  });

  it('reports never_deployed when the version has no last_deployed_at', async () => {
    await setup(false);
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
      title: 'Home', slug: 'home', status: 'published', content_mode: 'blocks', date_updated: BEFORE,
    });
    const body = await call();
    expect(body.never_deployed).toBe(true);
    expect(body.last_deployed_at).toBeNull();
    // Everything with a stamp counts as changed when nothing was ever deployed.
    expect(body.total).toBe(1);
  });
});
