// Who may start a new site from what, for the portal (session) and the
// public API (key) doors. new-site-source.ts loads the source once allowed.
//
//   - Another site: read access to it within the creating organization.
//     Sites shared in from other organizations are refused, however
//     privileged the share: a copy would move their content and media into
//     another organization.
//   - A collection entry: the collection rule (an owner, administrator or
//     builder of the organization; every member while it does not enforce
//     roles), the same as inserting from the collection.
//   - A package file: nothing more than creating a site. A package belongs
//     to no organization.
//
// A refusal answers 404 `site_source_not_found`, like a source that is not
// there, so the routes cannot be used to probe other organizations.

import type { AstroCookies } from 'astro';
import { paths, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { requireSiteAccess, resolveRequestedVersion, type FullSession } from '../access';
import { resolveOwnerOrgAccess, siteDesignAccess } from '../member-role';
import type { NewSiteFrom } from './new-site-source';
import { PackageError } from './package-zip';

const notFound = (what: string) => new PackageError(`${what} not found`, 404, 'site_source_not_found');

/** The version of the source site a copy reads; an unknown version is refused, never replaced by main. */
async function sourceVersion(orgId: string, siteId: string, requested: string | undefined): Promise<string> {
  const resolved = await resolveRequestedVersion(orgId, siteId, requested);
  if (!resolved.ok) throw new PackageError(`Unknown version "${resolved.requested}" of the site ${siteId}`, 404, 'site_source_not_found');
  return resolved.versionId;
}

/** Check a session may start a site from `from`; returns it with the source version resolved. */
export async function sessionNewSiteFrom(cookies: AstroCookies, session: FullSession, from: NewSiteFrom): Promise<NewSiteFrom & { version_id?: string }> {
  if (from.kind === 'site') {
    const access = await requireSiteAccess(cookies, from.site_id);
    if (!access.ok || !access.value.is_owner || access.value.owner_org_id !== session.orgId) throw notFound('Site');
    return { ...from, version_id: await sourceVersion(session.orgId, from.site_id, from.version) };
  }
  if (from.kind === 'collection_entry') {
    const access = await resolveOwnerOrgAccess(session.orgId, session.userId);
    if (!siteDesignAccess(access.permission, access.role)) throw notFound('Collection entry');
  }
  return from;
}

/**
 * Check an API caller may start a site from `from`. The root route admits
 * only callers acting as administrators of the token's organization (an
 * organization key, or a personal connection of an owner or administrator),
 * who may use the collection and read every site of the organization.
 */
export async function apiNewSiteFrom(tokenOrgId: string, from: NewSiteFrom): Promise<NewSiteFrom & { version_id?: string }> {
  if (from.kind === 'site') {
    const site = await getStore().getDoc<Site>(paths.site(tokenOrgId, from.site_id));
    if (!site) throw notFound('Site');
    return { ...from, version_id: await sourceVersion(tokenOrgId, from.site_id, from.version) };
  }
  return from;
}
