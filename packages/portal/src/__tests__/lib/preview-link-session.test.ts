// POST /api/sites/{siteId}/preview-link mints a signed link that shows
// unpublished content to anyone holding it. Read-only members preview inside
// the portal; minting a shareable link needs write permission.
//
// The cookie-less dev session is `dev-user` in organization `default`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'default';
const SITE = 'mysite';

async function seed(role: string): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.org(ORG), { name: 'Default', roles_enforced: true });
  await store.setDoc(`${paths.members(ORG)}/dev-user`, { role });
  await store.setDoc(paths.site(ORG, SITE), { name: 'Mine', created_at: '2026-01-01' });
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: '2026-01-01' });
}

async function mint(): Promise<Response> {
  const { POST } = await import('../../pages/api/sites/[siteId]/preview-link');
  const request = new Request(`https://portal.test/api/sites/${SITE}/preview-link`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'about' }),
  });
  return await POST!({ request, cookies: { get: () => undefined } as never, params: { siteId: SITE }, locals: {} } as never) as Response;
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.stubEnv('PREVIEW_HMAC_SECRET', 'synthetic-preview-signing-secret-32-characters');
});
afterEach(() => vi.unstubAllEnvs());

describe('session preview links', () => {
  it('refuses a read-only member', async () => {
    await seed('viewer');
    expect((await mint()).status).toBe(403);
  });

  it('lets an editor mint one', async () => {
    await seed('editor');
    const res = await mint();
    expect(res.status).toBe(200);
    expect((await res.json() as { url: string }).url).toMatch(new RegExp(`^/preview/${SITE}/about\\?t=`));
  });
});
