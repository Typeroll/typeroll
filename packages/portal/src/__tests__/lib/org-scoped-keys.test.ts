// Org-scoped API keys — auth, reach across owned + shared-in sites,
// read-only share gating.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { SiteShare } from '@typeroll/shared';

async function setupOwnedSite(orgId: string, siteId: string, name: string): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(orgId, siteId), {
    name, hosting_adapter: 'cloudflare',
  });
}

async function shareSite(args: {
  ownerOrgId: string;
  siteId: string;
  sharedWithOrgId: string;
  permission: 'read' | 'write' | 'admin';
}): Promise<void> {
  const { writeShare } = await import('../../lib/shares');
  const share: SiteShare = {
    id: `share-${args.siteId}-${args.sharedWithOrgId}`,
    site_id: args.siteId,
    owner_org_id: args.ownerOrgId,
    shared_with_org_id: args.sharedWithOrgId,
    permission: args.permission,
    created_at: Date.now(),
    created_by: 'tester',
  };
  await writeShare(share);
}

describe('createApiKey / verifyApiToken — org-scoped', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('creates and verifies an org-scoped key', async () => {
    const { createApiKey, verifyApiToken } = await import('../../lib/api-keys');
    const { token, key } = await createApiKey({
      orgId: 'default',
      siteId: null,
      name: 'org-key',
      createdBy: 'admin',
    });
    const verified = await verifyApiToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.orgId).toBe('default');
    expect(verified?.siteId).toBeNull();
    expect(verified?.prefix).toBe(key.id);
  });

  it('stores org-scoped keys at the org path, not under any site', async () => {
    const { createApiKey } = await import('../../lib/api-keys');
    const { key } = await createApiKey({
      orgId: 'default',
      siteId: null,
      name: 'org-key',
      createdBy: 'admin',
    });
    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc(paths.orgApiKey('default', key.id));
    expect(doc).not.toBeNull();
  });

  it('listApiKeys(orgId, null) returns only org-scoped keys', async () => {
    await setupOwnedSite('default', 'site-a', 'A');
    const { createApiKey, listApiKeys } = await import('../../lib/api-keys');
    await createApiKey({ orgId: 'default', siteId: 'site-a', name: 'site-key', createdBy: 'a' });
    await createApiKey({ orgId: 'default', siteId: null, name: 'org-key', createdBy: 'a' });

    const orgKeys = await listApiKeys('default', null);
    const siteKeys = await listApiKeys('default', 'site-a');
    expect(orgKeys).toHaveLength(1);
    expect(orgKeys[0]!.name).toBe('org-key');
    expect(siteKeys).toHaveLength(1);
    expect(siteKeys[0]!.name).toBe('site-key');
  });
});

describe('listAllowedSites', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('returns owned + shared-in sites for org-scoped tokens', async () => {
    await setupOwnedSite('default', 'owned-1', 'Owned 1');
    await setupOwnedSite('default', 'owned-2', 'Owned 2');
    await setupOwnedSite('agency', 'agency-site', 'Agency');
    await shareSite({
      ownerOrgId: 'agency',
      siteId: 'agency-site',
      sharedWithOrgId: 'default',
      permission: 'write',
    });

    const { listAllowedSites } = await import('../../lib/api-auth');
    const list = await listAllowedSites('default', null);
    const ids = list.map((s) => s.siteId).sort();
    expect(ids).toEqual(['agency-site', 'owned-1', 'owned-2']);
    const agency = list.find((s) => s.siteId === 'agency-site')!;
    expect(agency.permission).toBe('write');
    expect(agency.ownerOrgId).toBe('agency');
    const owned = list.find((s) => s.siteId === 'owned-1')!;
    expect(owned.permission).toBe('admin');
  });

  it('returns only the bound site for site-scoped tokens', async () => {
    await setupOwnedSite('default', 'only-this', 'Only');
    await setupOwnedSite('default', 'other', 'Other');
    const { listAllowedSites } = await import('../../lib/api-auth');
    const list = await listAllowedSites('default', 'only-this');
    expect(list).toHaveLength(1);
    expect(list[0]!.siteId).toBe('only-this');
  });
});

describe('requireApiKey — org-scoped reach', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('lets an org-scoped key reach any owned site', async () => {
    await setupOwnedSite('default', 'site-a', 'A');
    await setupOwnedSite('default', 'site-b', 'B');
    const { createApiKey } = await import('../../lib/api-keys');
    const { token } = await createApiKey({
      orgId: 'default', siteId: null, name: 'org', createdBy: 'a',
    });
    const { requireApiKey } = await import('../../lib/api-auth');
    const req = new Request('https://portal.test/api/v1/sites/site-b/pages', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const guard = await requireApiKey(req, 'site-b');
    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.value.site.name).toBe('B');
      expect(guard.value.orgId).toBe('default');
      expect(guard.value.permission).toBe('admin');
    }
  });

  it('lets an org-scoped key reach a shared-in site at the share permission', async () => {
    await setupOwnedSite('agency', 'agency-site', 'Agency');
    await shareSite({
      ownerOrgId: 'agency',
      siteId: 'agency-site',
      sharedWithOrgId: 'default',
      permission: 'read',
    });
    const { createApiKey } = await import('../../lib/api-keys');
    const { token } = await createApiKey({
      orgId: 'default', siteId: null, name: 'org', createdBy: 'a',
    });
    const { requireApiKey } = await import('../../lib/api-auth');
    const req = new Request('https://portal.test/api/v1/sites/agency-site/pages', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const guard = await requireApiKey(req, 'agency-site');
    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.value.orgId).toBe('agency');
      expect(guard.value.tokenOrgId).toBe('default');
      expect(guard.value.permission).toBe('read');
    }
  });

  it('rejects writes through a read-only share', async () => {
    await setupOwnedSite('agency', 'agency-site', 'Agency');
    await shareSite({
      ownerOrgId: 'agency',
      siteId: 'agency-site',
      sharedWithOrgId: 'default',
      permission: 'read',
    });
    const { createApiKey } = await import('../../lib/api-keys');
    const { token } = await createApiKey({
      orgId: 'default', siteId: null, name: 'org', createdBy: 'a',
    });
    const { requireApiKey } = await import('../../lib/api-auth');
    const req = new Request('https://portal.test/api/v1/sites/agency-site/pages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    const guard = await requireApiKey(req, 'agency-site');
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(403);
  });

  it('rejects org-scoped key reaching a site outside the org with no share', async () => {
    await setupOwnedSite('agency', 'someone-elses-site', 'No');
    const { createApiKey } = await import('../../lib/api-keys');
    const { token } = await createApiKey({
      orgId: 'default', siteId: null, name: 'org', createdBy: 'a',
    });
    const { requireApiKey } = await import('../../lib/api-auth');
    const req = new Request('https://portal.test/api/v1/sites/someone-elses-site/pages', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const guard = await requireApiKey(req, 'someone-elses-site');
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(401);
  });

  it('site-scoped key still works only for its bound site', async () => {
    await setupOwnedSite('default', 'one', 'One');
    await setupOwnedSite('default', 'two', 'Two');
    const { createApiKey } = await import('../../lib/api-keys');
    const { token } = await createApiKey({
      orgId: 'default', siteId: 'one', name: 'site-key', createdBy: 'a',
    });
    const { requireApiKey } = await import('../../lib/api-auth');
    const good = await requireApiKey(
      new Request('https://portal.test/api/v1/sites/one/pages', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      'one',
    );
    expect(good.ok).toBe(true);
    const wrong = await requireApiKey(
      new Request('https://portal.test/api/v1/sites/two/pages', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      'two',
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.response.status).toBe(401);
  });
});
