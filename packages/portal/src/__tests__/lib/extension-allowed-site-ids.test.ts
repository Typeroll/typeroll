// A private Extension's allowed_site_ids entries are a bare site id (the
// developer organization's own site) or `org/site` (another organization's
// site). The developer routes refuse anything else instead of storing an
// entry that never matches, or one whose meaning depends on a separator.

import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { paths, type Extension } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { isAllowedSiteEntry, parseAllowedSiteIds } from '../../lib/extensions/allowed-site-ids';

const DEV_ORG = 'developer-org';
const EXTENSION_ID = 'se.vendor.quote-generator';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.org(DEV_ORG), { name: 'Developer', slug: 'developer', plan: 'free', created_at: '2026-01-01' });
});

async function headers() {
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: DEV_ORG, siteId: null, name: 'Extension CLI', createdBy: 'developer-user' });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function create(body: Record<string, unknown>) {
  const route = await import('../../pages/api/developer/extensions/index') as Record<string, APIRoute>;
  const res = await route.POST!({
    request: new Request('https://portal.example/api/developer/extensions', {
      method: 'POST', headers: await headers(),
      body: JSON.stringify({ id: EXTENSION_ID, name: 'Quote Generator', distribution: 'private', ...body }),
    }),
    cookies: {} as never,
  } as never) as Response;
  return { status: res.status, json: await res.json() as any };
}

async function patch(body: Record<string, unknown>) {
  const route = await import('../../pages/api/developer/extensions/[extensionId]/index') as Record<string, APIRoute>;
  const res = await route.PATCH!({
    request: new Request(`https://portal.example/api/developer/extensions/${EXTENSION_ID}`, {
      method: 'PATCH', headers: await headers(), body: JSON.stringify(body),
    }),
    cookies: {} as never,
    params: { extensionId: EXTENSION_ID },
  } as never) as Response;
  return { status: res.status, json: await res.json() as any };
}

async function stored() {
  const { getStore } = await import('../../lib/datastore');
  return getStore().getDoc<Extension>(paths.extension(DEV_ORG, EXTENSION_ID));
}

describe('allowed_site_ids entries', () => {
  it('accepts bare ids and org/site, and nothing else', () => {
    for (const entry of ['main-site', 'Site_2', 'client-org/main-site']) expect(isAllowedSiteEntry(entry), entry).toBe(true);
    for (const entry of ['', '/main-site', 'client-org/', 'a/b/c', '../site', 'org/..', '.', 'has space', 'org\\site', 'x'.repeat(129), 'org/site\n']) {
      expect(isAllowedSiteEntry(entry), JSON.stringify(entry)).toBe(false);
    }
    expect(parseAllowedSiteIds(undefined)).toBeUndefined();
    expect(parseAllowedSiteIds(null)).toBeUndefined();
    expect(parseAllowedSiteIds(['a', 'a', 'org/a'])).toEqual(['a', 'org/a']);
    expect(() => parseAllowedSiteIds('main-site')).toThrow('array');
    expect(() => parseAllowedSiteIds([42])).toThrow('org/site');
    expect(() => parseAllowedSiteIds(Array.from({ length: 501 }, (_, i) => `s${i}`))).toThrow('at most');
  });

  it('are validated when an Extension is registered', async () => {
    expect((await create({ allowed_site_ids: ['client-org/site/extra'] })).status).toBe(400);
    expect((await create({ allowed_site_ids: [42] })).status).toBe(400);
    expect(await stored()).toBeNull();

    const created = await create({ allowed_site_ids: ['own-site', 'client-org/main-site'] });
    expect(created.status).toBe(201);
    expect((await stored())?.allowed_site_ids).toEqual(['own-site', 'client-org/main-site']);
  });

  it('are validated when the list is updated, without a partial write', async () => {
    expect((await create({})).status).toBe(201);
    const refused = await patch({ name: 'Renamed', allowed_site_ids: ['client-org/main-site', '../other-org/site'] });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain('org/site');
    expect(await stored()).toMatchObject({ name: 'Quote Generator' });
    expect((await stored())?.allowed_site_ids).toBeUndefined();

    const saved = await patch({ allowed_site_ids: ['client-org/main-site', 'own-site'] });
    expect(saved.status).toBe(200);
    expect((await stored())?.allowed_site_ids).toEqual(['client-org/main-site', 'own-site']);
  });
});
