// Redirect hygiene — keeps the redirects collection consistent with the
// pages collection. Cloudflare Pages processes `_redirects` BEFORE static
// files, so a redirect whose from_path equals a real page's URL shadows
// that page entirely: the root of a live site can 301 to a draft while the
// freshly-published home page sits unreachable behind it. Two invariants,
// enforced at every page write surface plus belt-and-braces in the deploy
// runner:
//
//   1. A live page taking over a URL retires any redirect FROM that URL
//      (a real page always beats a redirect).
//   2. Deleting a page removes auto-generated redirects pointing TO its
//      URL — they'd 301 visitors into a 404. Manually created redirects
//      are kept: the user may intend them (e.g. a placeholder for a page
//      that will come back).

import { isRedirectPattern, pagesShadowedByRedirect } from '@typeroll/shared';
import { vstore } from './version-store';
import type { Page, Redirect } from '@typeroll/shared';

/**
 * Statuses that produce an HTML file in the static build (the renderer
 * includes unlisted pages by default). Only these can be shadowed by a
 * redirect, and only these should retire one — retiring on a draft write
 * would break a redirect that's still serving live traffic.
 */
export function isLivePageStatus(status: Page['status'] | undefined): boolean {
  return status === 'published' || status === 'unlisted';
}

/**
 * Delete every redirect whose from_path equals `url` (a page now owns it).
 * Returns the deleted redirects so callers can surface them in responses.
 */
export async function retireRedirectsShadowingUrl(
  orgId: string,
  siteId: string,
  versionId: string,
  url: string,
): Promise<Redirect[]> {
  const all = await vstore.redirects(orgId, siteId, versionId);
  const shadowing = all.filter((r) => r.from_path === url);
  for (const r of shadowing) {
    await vstore.deleteRedirect(orgId, siteId, versionId, r.id);
  }
  return shadowing;
}

/**
 * Delete auto-generated redirects whose to_path equals `url` (the page at
 * that URL is gone). Manual redirects with the same to_path are left alone.
 */
export async function removeAutoRedirectsTargeting(
  orgId: string,
  siteId: string,
  versionId: string,
  url: string,
): Promise<Redirect[]> {
  const all = await vstore.redirects(orgId, siteId, versionId);
  const stale = all.filter((r) => r.auto_generated === true && r.to_path === url);
  for (const r of stale) {
    await vstore.deleteRedirect(orgId, siteId, versionId, r.id);
  }
  return stale;
}

/**
 * Pure partition used by the deploy runner: split redirects into rules
 * safe to emit vs rules whose from_path collides with a built page's URL.
 * Defence in depth — the write-surface hooks above should keep the data
 * clean, but a rule that slipped through (older data, direct datastore
 * writes) must never make it into `_redirects`.
 */
export function partitionShadowedRedirects<T extends Pick<Redirect, 'from_path' | 'to_path'>>(
  redirects: T[],
  livePageUrls: ReadonlySet<string>,
): { kept: T[]; shadowed: T[]; shadowedPages: Map<T, string[]> } {
  const kept: T[] = [];
  const shadowed: T[] = [];
  const shadowedPages = new Map<T, string[]>();
  for (const r of redirects) {
    // A wildcard can hide many pages at once — `/blogg/*` swallows every
    // real article under it. Same invariant as the exact case (a real page
    // always beats a redirect), just discovered by matching instead of by
    // set lookup. The write surfaces refuse such a pattern; this catches
    // the case where the page was published AFTER the rule was created.
    const hits = isRedirectPattern(r.from_path)
      ? pagesShadowedByRedirect(r.from_path, r.to_path ?? '', livePageUrls)
      : livePageUrls.has(r.from_path) ? [r.from_path] : [];
    if (hits.length) {
      shadowed.push(r);
      shadowedPages.set(r, hits);
    } else {
      kept.push(r);
    }
  }
  return { kept, shadowed, shadowedPages };
}
