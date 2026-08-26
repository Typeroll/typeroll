// /pages/{id}/changes — the structured "what would Save apply?" summary
// behind the Review-changes overlay and the MCP get_change_summary tool.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';

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
          session: { orgId: ORG, userId: 'u1', email: 't@example.com' },
          site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', status: 'live', created_at: '' },
          versionId: MAIN_VERSION_ID,
          owner_org_id: ORG,
          permission: 'admin' as const,
        },
      })),
    };
  });
}

async function call(pageId: string): Promise<Response> {
  const mod = await import('../../pages/api/sites/[siteId]/pages/[pageId]/changes');
  return mod.GET({
    cookies: { get: () => undefined },
    params: { siteId: SITE, pageId },
    locals: {},
  } as never) as Promise<Response>;
}

describe('page change summary route', () => {
  beforeEach(setup);

  it('reports meta + block changes between saved page and draft', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
      title: 'Home', slug: '', status: 'published', content_mode: 'blocks',
      blocks: [
        { id: 'h1', type: 'core/heading', data: { text: 'Old headline' } },
        { id: 'p1', type: 'core/prose', data: { text: '<p>Keep</p>' } },
      ],
    });
    const { mergeWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy(
      { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID },
      { kind: 'page', id: 'home' },
      {
        title: 'New home',
        blocks: [
          { id: 'h1', type: 'core/heading', data: { text: 'New headline' } },
          { id: 'p1', type: 'core/prose', data: { text: '<p>Keep</p>' } },
          { id: 'cta1', type: 'core/cta', data: { heading: 'Buy' } },
        ],
      },
    );

    const res = await call('home');
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.has_working_copy).toBe(true);
    expect(out.meta_changed).toEqual(['title']);
    expect(out.block_changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'changed', block_id: 'h1', fields: ['text'] }),
        expect.objectContaining({ kind: 'added', block_id: 'cta1', type: 'core/cta' }),
      ]),
    );
    expect(out.block_changes).toHaveLength(2); // p1 untouched → silent
  });

  it('no working copy → empty summary; unknown page → 404', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/clean`, {
      title: 'Clean', slug: 'clean', status: 'draft', content_mode: 'blocks', blocks: [],
    });
    const res = await call('clean');
    expect(await res.json()).toEqual({ has_working_copy: false, meta_changed: [], block_changes: [] });
    expect((await call('nope')).status).toBe(404);
  });
});
