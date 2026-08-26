// Discover which site a stdio invocation binds to.
//
// TYPEROLL_SITE_ID wins when set. Otherwise we ask GET /v1/sites: a
// site-scoped key returns exactly one entry; an org-scoped key can return
// many, in which case TYPEROLL_SITE_ID is required so this stdio invocation
// maps onto one specific site.

import type { TyperollClient } from './client.js';

export interface SiteListItem {
  id: string;
  name: string;
  domain?: string;
}

export async function resolveSiteId(client: TyperollClient): Promise<string> {
  const fromEnv = process.env.TYPEROLL_SITE_ID?.trim();
  if (fromEnv) return fromEnv;
  const res = await client.rootGet<{ sites: SiteListItem[] }>('sites');
  if (!res.sites || res.sites.length === 0) {
    throw new Error('No sites returned for this API key. Check the key is valid.');
  }
  if (res.sites.length > 1) {
    throw new Error(
      `This key authorises ${res.sites.length} sites; set TYPEROLL_SITE_ID to pick one. ` +
        'Org-scoped keys span multiple sites — stdio currently binds to one at a time.',
    );
  }
  // Defense in depth: portals before the /v1/sites org-key fix returned a
  // single placeholder entry with an empty id for org-scoped keys. Binding
  // to "" would make every subsequent call fail incomprehensibly — reject
  // it with an actionable message instead.
  const id = res.sites[0]!.id?.trim();
  if (!id) {
    throw new Error(
      'The portal returned a site with an empty id (org-scoped key against an older portal). ' +
        'Set TYPEROLL_SITE_ID to pick a site explicitly, or upgrade the portal.',
    );
  }
  return id;
}
