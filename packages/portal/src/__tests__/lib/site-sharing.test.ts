// Cross-org site sharing — end-to-end integration tests.
//
// All scenarios run through the dev session (orgId = 'default') and stage
// owner-org data under a different org id ('agencyorg') so the only way the
// caller can reach the site is through a SiteShare.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { SiteShare } from '@typeroll/shared';

const fakeCookies = {
  get: () => undefined,
} as unknown as Parameters<typeof import('../../lib/access').requireSiteAccess>[0];

const OWNER = 'agencyorg';
const CALLER = 'default';
const SITE = 'shared-site';

async function stageOwnedSite(): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(OWNER, SITE), {
    name: 'Customer Site',
    hosting_adapter: 'cloudflare',
  });
}

async function stageShare(permission: 'read' | 'write' | 'admin'): Promise<SiteShare> {
  const { writeShare } = await import('../../lib/shares');
  const share: SiteShare = {
    id: 'share-1',
    site_id: SITE,
    owner_org_id: OWNER,
    shared_with_org_id: CALLER,
    permission,
    created_at: Date.now(),
    created_by: 'tester',
  };
  await writeShare(share);
  return share;
}

describe('requireSiteAccess + sharing', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('falls back to the share index when the caller does not own the site', async () => {
    await stageOwnedSite();
    await stageShare('write');
    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, SITE);
    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.value.site.name).toBe('Customer Site');
      expect(guard.value.permission).toBe('write');
      expect(guard.value.owner_org_id).toBe(OWNER);
      expect(guard.value.session.orgId).toBe(CALLER);
    }
  });

  it('returns 404 when no share exists', async () => {
    await stageOwnedSite();
    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, SITE);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(404);
  });

  it('reports admin permission for the owning org', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(CALLER, 'owned-site'), {
      name: 'Mine', hosting_adapter: 'cloudflare',
    });
    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, 'owned-site');
    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.value.permission).toBe('admin');
      expect(guard.value.owner_org_id).toBe(CALLER);
    }
  });

  it('treats a revoked share as no share at all', async () => {
    await stageOwnedSite();
    const share = await stageShare('write');
    const { revokeShare } = await import('../../lib/shares');
    await revokeShare(OWNER, SITE, share.id);
    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, SITE);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(404);
  });

  it('fails closed if the index points at a deleted canonical record', async () => {
    await stageOwnedSite();
    const share = await stageShare('admin');
    // Delete the canonical record but leave the flat index dangling.
    const { getStore } = await import('../../lib/datastore');
    await getStore().deleteDoc(paths.share(OWNER, SITE, share.id));
    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, SITE);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(404);
  });

  it('exposes the granted permission to callers (not always admin)', async () => {
    await stageOwnedSite();
    await stageShare('read');
    const { requireSiteAccess } = await import('../../lib/access');
    const guard = await requireSiteAccess(fakeCookies, SITE);
    expect(guard.ok).toBe(true);
    if (guard.ok) expect(guard.value.permission).toBe('read');
  });
});

describe('requirePermission', () => {
  it('lets admin do everything', async () => {
    const { requirePermission } = await import('../../lib/access');
    const ctx = { permission: 'admin' as const } as Parameters<typeof requirePermission>[0];
    expect(requirePermission(ctx, 'read').ok).toBe(true);
    expect(requirePermission(ctx, 'write').ok).toBe(true);
    expect(requirePermission(ctx, 'admin').ok).toBe(true);
  });

  it('lets write do read+write but not admin', async () => {
    const { requirePermission } = await import('../../lib/access');
    const ctx = { permission: 'write' as const } as Parameters<typeof requirePermission>[0];
    expect(requirePermission(ctx, 'read').ok).toBe(true);
    expect(requirePermission(ctx, 'write').ok).toBe(true);
    const adminCheck = requirePermission(ctx, 'admin');
    expect(adminCheck.ok).toBe(false);
    if (!adminCheck.ok) expect(adminCheck.response.status).toBe(403);
  });

  it('lets read do only read', async () => {
    const { requirePermission } = await import('../../lib/access');
    const ctx = { permission: 'read' as const } as Parameters<typeof requirePermission>[0];
    expect(requirePermission(ctx, 'read').ok).toBe(true);
    expect(requirePermission(ctx, 'write').ok).toBe(false);
    expect(requirePermission(ctx, 'admin').ok).toBe(false);
  });
});

describe('shares lib helpers', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('writes both the canonical record and the flat index', async () => {
    await stageOwnedSite();
    const share = await stageShare('write');
    const { getStore } = await import('../../lib/datastore');
    const canonical = await getStore().getDoc<SiteShare>(paths.share(OWNER, SITE, share.id));
    const indexed = await getStore().getDoc<SiteShare>(paths.sharesWithOrgEntry(CALLER, share.id));
    expect(canonical?.site_id).toBe(SITE);
    expect(indexed?.site_id).toBe(SITE);
    expect(indexed?.owner_org_id).toBe(OWNER);
  });

  it('updateShare can change permission and label independently', async () => {
    await stageOwnedSite();
    const share = await stageShare('read');
    const { updateShare } = await import('../../lib/shares');
    const after = await updateShare(OWNER, SITE, share.id, { permission: 'write' });
    expect(after?.permission).toBe('write');
    const labelled = await updateShare(OWNER, SITE, share.id, { label: 'Acme review' });
    expect(labelled?.label).toBe('Acme review');
    expect(labelled?.permission).toBe('write'); // unchanged
  });

  it('listSharedWithOrg drops revoked entries', async () => {
    await stageOwnedSite();
    const share = await stageShare('write');
    const { revokeShare, listSharedWithOrg } = await import('../../lib/shares');
    await revokeShare(OWNER, SITE, share.id);
    const list = await listSharedWithOrg(CALLER);
    expect(list).toHaveLength(0);
  });

  it('hydrateSharedSites returns site + share pairs', async () => {
    await stageOwnedSite();
    await stageShare('write');
    const { hydrateSharedSites } = await import('../../lib/shares');
    const list = await hydrateSharedSites(CALLER);
    expect(list).toHaveLength(1);
    expect(list[0]!.site.name).toBe('Customer Site');
    expect(list[0]!.share.permission).toBe('write');
  });
});
