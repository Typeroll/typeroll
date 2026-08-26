/**
 * Centralised URL composition for live deploys + in-portal previews.
 *
 * The "live" base for a given site+version is:
 *   - main  → https://{site.domain} when the customer has set their real
 *             domain; otherwise the auto-provisioned fallback subdomain
 *             (e.g. {slug}.sites.typeroll.com) so they can preview the
 *             deployed site before DNS cutover. Null when neither exists.
 *   - branch → version.deploy_url if the branch has been deployed
 *             somewhere, else null (no live URL exists yet).
 *
 * The "preview" base is always the navigable preview endpoint in the
 * portal — the user can browse drafts and unpublished edits regardless of
 * whether the version is deployed.
 */

import { MAIN_VERSION_ID } from '@typeroll/shared';
import type { Page, Site, SiteVersion } from '@typeroll/shared';

function normalizeSlug(slug: string | undefined): string {
  const s = (slug ?? '').replace(/^\/+|\/+$/g, '');
  return s === 'home' || s === 'index' || s === '' ? '' : s;
}

/**
 * Resolve the live URL path (everything after the host) for a page.
 * When `path` is set, it wins; otherwise fall back to "/" + slug (or
 * "/" for the homepage). Mirrors urlFor() in the site-template renderer
 * — keep them aligned. See docs/page-path-plan.md.
 */
export function pagePathSegment(page: Pick<Page, 'slug' | 'path'>): string {
  if (typeof page.path === 'string' && page.path.length > 0) {
    if (page.path === '/') return '';
    return page.path.replace(/^\/+|\/+$/g, '');
  }
  return normalizeSlug(page.slug);
}

/** Strip trailing slash for clean concatenation. */
function trimRight(base: string): string {
  return base.replace(/\/$/, '');
}

type SiteUrlInput = Pick<Site, 'domain' | 'hosting_config'>;

/**
 * Resolve the live (deployed) base URL for a site/version pair. Returns null
 * if the version has nowhere to point at: main without a domain AND without
 * a fallback subdomain, or a branch that hasn't been deployed.
 */
export function liveBaseFor(site: SiteUrlInput, version: SiteVersion | null): string | null {
  if (!version || version.kind === 'main' || version.id === MAIN_VERSION_ID) {
    if (site.domain) return `https://${site.domain}`;
    const fallback = site.hosting_config?.fallback_subdomain;
    return fallback ? `https://${fallback}` : null;
  }
  return version.deploy_url ? trimRight(version.deploy_url) : null;
}

/** Live URL for a specific page, or null when there's no live URL to point at. */
export function pageLiveUrl(
  site: SiteUrlInput,
  version: SiteVersion | null,
  page: Pick<Page, 'slug' | 'path' | 'status'>,
): string | null {
  if (page.status !== 'published') return null;
  const base = liveBaseFor(site, version);
  if (!base) return null;
  const seg = pagePathSegment(page);
  return seg ? `${base}/${seg}` : `${base}/`;
}

/**
 * The "where am I reachable?" label for the dashboard header. Returns the
 * customer's real domain when set, otherwise the fallback subdomain (with
 * a hint that it's the preview URL), otherwise null.
 */
export function siteDisplayHost(site: SiteUrlInput): { host: string; isFallback: boolean } | null {
  if (site.domain) return { host: site.domain, isFallback: false };
  const fallback = site.hosting_config?.fallback_subdomain;
  if (fallback) return { host: fallback, isFallback: true };
  return null;
}

/** Navigable preview URL inside the portal — always available, includes drafts. */
export function pagePreviewUrl(siteId: string, page: Pick<Page, 'slug' | 'path'>): string {
  const seg = pagePathSegment(page);
  return `/api/sites/${siteId}/preview/browse/${seg}`;
}
