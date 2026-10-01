// Branch review and reset over the public API, with the portal's permission
// rules: anyone who can read the site can diff a branch; create, reset, merge
// and delete require admin permission, exactly as the session routes do.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteShare, SiteVersion } from '@typeroll/shared';

const ORG = 'ownerorg';
const PARTNER = 'partnerorg';
const SITE = 'mysite';
let adminToken = '';
let writeToken = '';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await store.setDoc(paths.version(ORG, SITE, 'feature'), {
    name: 'Feature', kind: 'branch', base_version_id: MAIN_VERSION_ID, created_at: new Date().toISOString(), robots_blocked: true,
  } satisfies Partial<SiteVersion>);
  await store.setDoc(paths.page(ORG, SITE, 'home', MAIN_VERSION_ID), { title: 'Home', slug: 'home', status: 'published', html_content: '<p>Main</p>' });
  await store.setDoc(paths.page(ORG, SITE, 'home', 'feature'), { title: 'Home', slug: 'home', status: 'published', html_content: '<p>Branch</p>' });
  await store.setDoc(paths.page(ORG, SITE, 'new-page', 'feature'), { title: 'New', slug: 'new-page', status: 'draft', html_content: '<p>New</p>' });
  const { writeShare } = await import('../../lib/shares');
  await writeShare({
    id: 'share-1', site_id: SITE, owner_org_id: ORG, shared_with_org_id: PARTNER,
    permission: 'write', created_at: Date.now(), created_by: 'owner@example.com',
  } satisfies SiteShare);
  const { createApiKey } = await import('../../lib/api-keys');
  adminToken = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'admin', createdBy: 'admin' })).token;
  writeToken = (await createApiKey({ orgId: PARTNER, siteId: null, name: 'partner', createdBy: 'partner' })).token;
}

async function call(modPath: string, method: 'GET' | 'POST' | 'DELETE', versionId: string, token: string, suffix = ''): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ modPath)) as Partial<Record<string, APIRoute>>;
  const req = new Request(`http://localhost/api/v1/sites/${SITE}/versions/${versionId}${suffix}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
  return mod[method]!({ request: req, params: { siteId: SITE, versionId }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

const diff = (versionId: string, token = adminToken) => call('../../pages/api/v1/sites/[siteId]/versions/[versionId]/diff', 'GET', versionId, token, '/diff');
const reset = (versionId: string, token = adminToken) => call('../../pages/api/v1/sites/[siteId]/versions/[versionId]/reset', 'POST', versionId, token, '/reset');

describe('version diff and reset over the v1 API', () => {
  beforeEach(async () => { await setup(); });

  it('diffs a branch against main for any reader, including a write share', async () => {
    for (const token of [adminToken, writeToken]) {
      const res = await diff('feature', token);
      expect(res.status).toBe(200);
      const body = await res.json() as { version_id: string; base_version_id: string; diff: { pages: { added: string[]; modified: string[] }; totalChanges: number } };
      expect(body).toMatchObject({ version_id: 'feature', base_version_id: MAIN_VERSION_ID });
      expect(body.diff.pages).toMatchObject({ added: ['new-page'], modified: ['home'] });
      expect(body.diff.totalChanges).toBe(2);
    }
    expect((await diff(MAIN_VERSION_ID)).status).toBe(400);
    expect((await diff('missing')).status).toBe(404);
  });

  it('resets a branch to main for admins only and keeps the branch', async () => {
    expect((await reset('feature', writeToken)).status).toBe(403);
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(paths.page(ORG, SITE, 'home', 'feature'))).not.toBeNull();

    const res = await reset('feature');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; cleared: { pages: { added: string[]; modified: string[] } } };
    expect(body.ok).toBe(true);
    expect(body.cleared.pages).toMatchObject({ added: ['new-page'], modified: ['home'] });
    expect(await getStore().getDoc(paths.page(ORG, SITE, 'home', 'feature'))).toBeNull();
    expect(await getStore().getDoc(paths.page(ORG, SITE, 'new-page', 'feature'))).toBeNull();
    expect(await getStore().getDoc(paths.version(ORG, SITE, 'feature'))).not.toBeNull();
    expect(((await (await diff('feature')).json()) as { diff: { totalChanges: number } }).diff.totalChanges).toBe(0);

    expect((await reset(MAIN_VERSION_ID)).status).toBe(400);
    expect((await reset('missing')).status).toBe(404);
  });

  it('requires admin permission to create, merge or delete a branch, as the portal does', async () => {
    const merge = (token: string) => call('../../pages/api/v1/sites/[siteId]/versions/[versionId]/merge', 'POST', 'feature', token, '/merge');
    const remove = (token: string) => call('../../pages/api/v1/sites/[siteId]/versions/[versionId]', 'DELETE', 'feature', token);
    expect((await merge(writeToken)).status).toBe(403);
    expect((await remove(writeToken)).status).toBe(403);
    const create = async (token: string) => {
      const mod = await import('../../pages/api/v1/sites/[siteId]/versions/index');
      return mod.POST({
        request: new Request(`http://localhost/api/v1/sites/${SITE}/versions`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'Another' }),
        }),
        params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {},
      } as never) as Promise<Response>;
    };
    expect((await create(writeToken)).status).toBe(403);
    expect((await create(adminToken)).status).toBe(201);
    expect((await merge(adminToken)).status).toBe(200);
    expect((await remove(adminToken)).status).toBe(200);
  });
});
