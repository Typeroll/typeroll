// Cross-org site sharing — datastore helpers.
//
// A SiteShare grants an entire org access to a single site owned by a
// different org. Two writes per grant — the canonical record under the
// owner site, and a flat index entry under the recipient org's
// org_share_index/. Readers (requireSiteAccess) discover via the flat
// index then re-fetch the canonical record so a stale or half-written
// index entry can't grant access.

import { paths } from '@typeroll/shared';
import type { Organization, Site, SiteShare, SharePermission } from '@typeroll/shared';
import { getStore } from './datastore';

/**
 * Write both the canonical share record and the flat-index mirror. The two
 * paths are not atomic in either backend; we always write canonical first
 * so the index can't dangle pointing at a missing record. A failure in the
 * second write leaves a usable share — the owner sees it in their grants
 * list; the recipient just doesn't see it in the "shared with me" list
 * until the index is repaired. Worth a future reconciliation pass.
 */
export async function writeShare(share: SiteShare): Promise<void> {
  const store = getStore();
  const { id, owner_org_id, site_id, shared_with_org_id } = share;
  const { id: _id, ...body } = share;
  await store.setDoc(paths.share(owner_org_id, site_id, id), body as unknown as Record<string, unknown>);
  await store.setDoc(
    paths.sharesWithOrgEntry(shared_with_org_id, id),
    body as unknown as Record<string, unknown>,
  );
}

/**
 * Revoke a share. Soft-deletes the canonical record (sets revoked_at so
 * the owner's audit/history view can still show "this org used to have
 * access") and hard-deletes the flat-index entry so listing shared-in
 * sites stays fast.
 */
export async function revokeShare(
  ownerOrgId: string,
  siteId: string,
  shareId: string,
): Promise<SiteShare | null> {
  const store = getStore();
  const canonical = await store.getDoc<SiteShare>(paths.share(ownerOrgId, siteId, shareId));
  if (!canonical) return null;
  const now = Date.now();
  await store.updateDoc(paths.share(ownerOrgId, siteId, shareId), { revoked_at: now });
  await store.deleteDoc(paths.sharesWithOrgEntry(canonical.shared_with_org_id, shareId));
  return { ...canonical, revoked_at: now };
}

/**
 * Update an existing share's permission level. Owner-only (callers must
 * gate). Mirrors the change across both the canonical record and the
 * flat-index entry so listings on either side stay in sync.
 */
export async function updateShare(
  ownerOrgId: string,
  siteId: string,
  shareId: string,
  patch: { permission?: SharePermission; label?: string },
): Promise<SiteShare | null> {
  const store = getStore();
  const canonical = await store.getDoc<SiteShare>(paths.share(ownerOrgId, siteId, shareId));
  if (!canonical || canonical.revoked_at) return null;
  const update: Record<string, unknown> = {};
  if (patch.permission !== undefined) update.permission = patch.permission;
  if (patch.label !== undefined) update.label = patch.label || undefined;
  if (Object.keys(update).length === 0) return canonical;
  await store.updateDoc(paths.share(ownerOrgId, siteId, shareId), update);
  await store.updateDoc(
    paths.sharesWithOrgEntry(canonical.shared_with_org_id, shareId),
    update,
  );
  return {
    ...canonical,
    permission: patch.permission ?? canonical.permission,
    label: patch.label !== undefined ? patch.label || undefined : canonical.label,
  };
}

/** List shares granted on a single site (canonical records, including revoked). */
export async function listSharesForSite(
  ownerOrgId: string,
  siteId: string,
): Promise<SiteShare[]> {
  return getStore().listDocs<SiteShare>(paths.shares(ownerOrgId, siteId));
}

/**
 * List active shares pointing at the given recipient org. Returns the
 * flat-index entries; callers wanting the canonical record should
 * re-fetch via paths.share(owner_org_id, site_id, id).
 */
export async function listSharedWithOrg(orgId: string): Promise<SiteShare[]> {
  const all = await getStore().listDocs<SiteShare>(paths.sharesWithOrg(orgId));
  return all.filter((s) => !s.revoked_at);
}

/**
 * Resolve a sharing target to an orgId. v1 accepts a direct org id or a
 * slug; the email-of-user mode the plan mentions is deferred until a real
 * use case asks for it (it needs a global members index).
 */
export async function resolveTargetOrg(
  input: { org_id?: string; org_slug?: string },
): Promise<{ orgId: string; org: Organization } | { error: string }> {
  const store = getStore();
  if (input.org_id) {
    const org = await store.getDoc<Organization>(paths.org(input.org_id));
    if (!org) return { error: 'Target organization not found' };
    return { orgId: input.org_id, org };
  }
  if (input.org_slug) {
    // Listing all orgs is cheap on the fixtures backend and on Firestore at
    // the scales we care about (org count is in the thousands max). When
    // this grows, replace with a denormalized slug → id index.
    const orgs = await store.listDocs<Organization>('organizations');
    const match = orgs.find((o) => o.slug === input.org_slug);
    if (!match) return { error: 'Target organization not found' };
    return { orgId: match.id, org: match };
  }
  return { error: 'org_id or org_slug required' };
}

/**
 * Hydrate flat-index share entries into `{ share, site }` pairs by reading
 * each owning site. Used by GET /api/me/shared-sites so the dashboard can
 * render the same Site cards as for owned sites. A share whose underlying
 * site no longer exists is dropped silently — it's a stale index entry the
 * recipient can't act on anyway.
 */
export async function hydrateSharedSites(
  orgId: string,
): Promise<Array<{ share: SiteShare; site: Site & { id: string } }>> {
  const shares = await listSharedWithOrg(orgId);
  const out: Array<{ share: SiteShare; site: Site & { id: string } }> = [];
  for (const share of shares) {
    const site = await getStore().getDoc<Site>(paths.site(share.owner_org_id, share.site_id));
    if (!site) continue;
    out.push({ share, site });
  }
  return out;
}
