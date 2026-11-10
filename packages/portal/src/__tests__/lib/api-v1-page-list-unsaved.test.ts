// The page list reports unsaved working-copy edits, like GET /pages/{id}.
import { describe, it, expect } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const ctx = { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID };

async function setup(): Promise<string> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false } satisfies Partial<SiteVersion>);
  for (const id of ['about', 'contact']) {
    await getStore().setDoc(paths.page(ORG, SITE, id, MAIN_VERSION_ID), {
      title: id, slug: id, status: 'published', content_mode: 'blocks', date_updated: '2026-01-01',
      blocks: [{ id: 'h', type: 'core/heading', data: { text: id, level: 'h1' } }],
    });
  }
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' })).token;
}

async function list(token: string): Promise<Record<string, boolean>> {
  const { GET } = await import('../../pages/api/v1/sites/[siteId]/pages/index');
  const res = await GET({ request: new Request(`http://localhost/api/v1/sites/${SITE}/pages`, { headers: { authorization: `Bearer ${token}` } }), params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {} } as any) as Response;
  expect(res.status).toBe(200);
  const body = await res.json() as { pages: Array<{ id: string; has_unsaved_changes: boolean }> };
  return Object.fromEntries(body.pages.map(p => [p.id, p.has_unsaved_changes]));
}

describe('GET /api/v1/sites/{site}/pages has_unsaved_changes', () => {
  it('is true for a page with a working copy until it is committed', async () => {
    const token = await setup();
    expect(await list(token)).toEqual({ about: false, contact: false });
    const { mergeWorkingCopy, commitWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy(ctx, { kind: 'page', id: 'about' }, { blocks: [{ id: 'h', type: 'core/heading', data: { text: 'Changed', level: 'h1' } }] });
    expect(await list(token)).toEqual({ about: true, contact: false });
    await commitWorkingCopy(ctx, { kind: 'page', id: 'about' }, 'admin');
    expect(await list(token)).toEqual({ about: false, contact: false });
  });
});
