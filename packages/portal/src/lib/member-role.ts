// Org member roles — turning the declared MemberRole into real authority.
//
// `MemberRole` ('owner' | 'admin' | 'editor') has been on the Member doc since
// orgs shipped — `orgs/create.ts` writes 'owner', `orgs/invite/join.ts` writes
// 'editor' — but nothing ever read it. `requireSiteAccess` returned
// `permission: 'admin'` unconditionally for every site the session's org owns,
// so an invited editor held full authority over settings, sharing, API keys,
// domains and versions. The role existed in the data and not in the system.
//
// Enforcement is OPT-IN PER ORG (`Organization.roles_enforced`, default off).
// Turning it on globally would demote every existing member the moment it
// deployed, including orgs whose only 'owner' has left — those members would
// lose access to their own settings with no way back. Off-by-default matches
// every other behaviour-changing switch on the platform (apps,
// ai_scripts_enabled).
//
// The mapping needs no route changes. The routes already gated on
// `requirePermission(ctx, 'admin')` are exactly the ones an editor shouldn't
// reach — settings, api-keys, shares, domain, versions, apps, integrations,
// deploy, export — and 'write' is already the content-editing level. So
// enforcement is a question of what `requireSiteAccess` reports, not of
// annotating 47 route files.

import { paths } from '@typeroll/shared';
import type { Member, MemberRole, Organization, SharePermission } from '@typeroll/shared';
import { getStore } from './datastore';

/**
 * Role → site permission. 'owner' and 'admin' both map to full authority;
 * they differ in org-level meaning (who can remove whom), not in what they
 * may do to a site.
 */
export const ROLE_PERMISSION: Record<MemberRole, SharePermission> = {
  owner: 'admin',
  admin: 'admin',
  editor: 'write',
};

export interface OwnerOrgAccess {
  permission: SharePermission;
  /** Undefined when enforcement is off — nothing was looked up. */
  role?: MemberRole;
}

/**
 * What a session may do on a site its OWN org owns.
 *
 * Only called on the owned-site path: a shared-in site takes its permission
 * from the SiteShare, which is already an explicit per-org grant and doesn't
 * consult the recipient's internal roles.
 *
 * Fails closed once enforcement is on — a member doc that's missing or
 * carries an unrecognised role resolves to 'read', matching auth.ts's
 * "a verified user without an org claim is rejected" posture. It cannot
 * strand anyone who didn't opt in, because opting in is the org's own act.
 */
export async function resolveOwnerOrgAccess(
  orgId: string,
  userId: string,
): Promise<OwnerOrgAccess> {
  const store = getStore();
  const org = await store.getDoc<Organization>(paths.org(orgId));

  // Default path: enforcement off (or no org doc at all, as in the bundled
  // fixtures and every test) → today's behaviour exactly, and no second read.
  if (!org?.roles_enforced) return { permission: 'admin' };

  const member = await store.getDoc<Member>(`${paths.members(orgId)}/${userId}`);
  const role = member?.role;
  if (!role || !(role in ROLE_PERMISSION)) return { permission: 'read' };
  return { permission: ROLE_PERMISSION[role], role };
}
