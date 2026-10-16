import { paths, type Site, type SiteShare, type SharePermission } from '@typeroll/shared';
import { getStore } from './datastore';
import { listOrganizations } from './organization-session';
import { resolveOwnerOrgAccess } from './member-role';
import { hydrateSharedSites } from './shares';

export const personalOrganizations = (userId: string) => listOrganizations({ userId, email: '', orgId: undefined });

/** Discover candidates from the index, but authorize against live membership and shares. */
export async function personalSites(userId: string) {
  const result = new Map<string, {
    siteId: string; ownerOrgId: string; accessOrgId: string;
    permission: SharePermission; site: Site & { id: string };
  }>();
  const rank = { read: 0, write: 1, admin: 2 };
  for (const org of await personalOrganizations(userId)) {
    const [owned, shared, access] = await Promise.all([
      getStore().listDocs<Site>(paths.sites(org.id)), hydrateSharedSites(org.id),
      resolveOwnerOrgAccess(org.id, userId),
    ]);
    const liveShared = (await Promise.all(shared.map(async ({ site, share }) => {
      const canonical = await getStore().getDoc<SiteShare>(paths.share(share.owner_org_id, site.id, share.id));
      return canonical && !canonical.revoked_at && canonical.owner_org_id === share.owner_org_id
        && canonical.site_id === site.id && canonical.shared_with_org_id === org.id
        && Object.hasOwn(rank, canonical.permission) ? { site, share: canonical } : null;
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const candidates = [
      ...owned.map(site => ({ siteId: site.id, ownerOrgId: org.id, accessOrgId: org.id, permission: access.permission, site })),
      ...liveShared.map(({ site, share }) => ({ siteId: site.id, ownerOrgId: share.owner_org_id, accessOrgId: org.id, permission: share.permission, site })),
    ];
    for (const candidate of candidates) {
      const key = JSON.stringify([candidate.ownerOrgId, candidate.siteId]);
      const existing = result.get(key);
      if (!existing || rank[candidate.permission] > rank[existing.permission]
          || (candidate.ownerOrgId === candidate.accessOrgId && rank[candidate.permission] === rank[existing.permission])) {
        result.set(key, candidate);
      }
    }
  }
  return [...result.values()];
}

/** Site calls read only this site and its grants, not every site's content tree. */
export async function resolvePersonalSite(userId: string, ownerOrgId: string, siteId: string) {
  if (![ownerOrgId, siteId].every(id => id && id.length <= 128 && id !== '.' && id !== '..' && !/[/\\\x00-\x1f]/.test(id))) return null;
  const { organizationMembership } = await import('./organization-session');
  const store = getStore();
  const site = await store.getDoc<Site>(paths.site(ownerOrgId, siteId));
  if (!site) return null;
  let best: Awaited<ReturnType<typeof personalSites>>[number] | null = null;
  const membership = await organizationMembership(userId, ownerOrgId);
  if (membership) {
    const { permission } = await resolveOwnerOrgAccess(ownerOrgId, userId);
    best = { site, siteId, ownerOrgId, accessOrgId: ownerOrgId, permission };
    if (permission === 'admin') return best;
  }
  const shares = await store.listDocs<import('@typeroll/shared').SiteShare>(paths.shares(ownerOrgId, siteId));
  const rank = { read: 0, write: 1, admin: 2 };
  for (const share of shares) {
    if (share.revoked_at || share.owner_org_id !== ownerOrgId || share.site_id !== siteId || !Object.hasOwn(rank, share.permission)) continue;
    if (best && rank[share.permission] <= rank[best.permission]) continue;
    const member = await organizationMembership(userId, share.shared_with_org_id);
    if (!member || !await store.getDoc(paths.sharesWithOrgEntry(member.id, share.id))) continue;
    best = { site, siteId, ownerOrgId, accessOrgId: member.id, permission: share.permission };
  }
  return best;
}
