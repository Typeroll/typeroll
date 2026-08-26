// Public URL shape returned to API consumers. Centralised so /v1/sites/{id}
// and /v1/sites/{id}/settings always agree on what "production" vs "preview"
// means for a given site.
//
// Production URL (domain-first model):
//   - site.domain whenever a domain is declared — that IS the canonical /
//     production URL the moment it's entered, before DNS is pointed. The
//     customer declares the domain first, we republish with it baked in as
//     canonical, then they point DNS at us last.
//   - null when no domain has been declared yet (site is still in the
//     develop-on-the-fallback-subdomain phase).
//
// `domain_status` (pending/verified/failed) is a DNS-health DIAGNOSTIC, not a
// gate on the production URL. `pending_domain` surfaces the domain while its
// DNS isn't confirmed yet so the UI can prompt the customer to point it. See
// docs/domain-lifecycle-plan.md for the full flow.
//
// Preview base is the portal origin where signed preview tokens land —
// agents combine it with their own get_preview_link mint to produce the
// clickable URL. Not the same as production: preview is always pre-deploy.

import type { Site } from '@typeroll/shared';

export interface PublicSiteUrls {
  /** Live URL of the deployed site. Only populated when domain_status
   *  is `'verified'`/`'live'` (or, for legacy sites, when domain is set
   *  without a status field but `domain_verified_at` proves DNS was
   *  confirmed). Null otherwise — agents falling back to fallback
   *  URL is the right behaviour pre-activation. */
  production: string | null;
  /** Hostname recorded on the site but not yet active as production.
   *  Returned so the UI can show "Awaiting DNS" / "Ready to activate"
   *  states without re-deriving the lifecycle. Null when status is
   *  `'live'` (or when no domain is configured at all). */
  pending_domain: string | null;
  /** Lifecycle state of the custom domain. Mirrors `Site.domain_status`
   *  so API consumers don't have to read it from two places. Null when
   *  no domain has been added. */
  domain_status: 'pending' | 'verified' | 'live' | 'failed' | null;
  /** Auto-provisioned `{slug}.{SITES_BASE_DOMAIN}` URL — useful as a stable
   *  preview before the customer cuts DNS over to their real domain.
   *  Null when SITES_BASE_DOMAIN isn't configured (self-hosted without
   *  the SaaS-wildcard zone). Falls through to using site.id when
   *  site.slug isn't set. */
  fallback: string | null;
  /** Optional staging URL if the customer wired one (rare in self-host;
   *  hosted SaaS sets this when a staging environment exists). */
  staging: string | null;
  /** Base under which signed preview tokens render. Combine with the
   *  token from get_preview_link to get a full URL. */
  preview_base: string | null;
}

/**
 * Is the custom domain the site's canonical/production host? In the
 * domain-first model the answer is simply "yes, as soon as a domain is
 * declared" — `!!site.domain`. The customer enters the domain they intend to
 * use FIRST; the build immediately bakes it as the canonical everywhere
 * (sitemap, <link rel=canonical>, JSON-LD) and republishes; the customer
 * points DNS at us LAST. `domain_status` (pending/verified/failed) is just a
 * DNS-health diagnostic for the UI — it does NOT gate the canonical.
 *
 * Why not gate on DNS verification: Cloudflare Pages serves a custom domain
 * publicly the instant DNS resolves, and the WHOLE point of declaring the
 * domain first is that the canonical is already correct when DNS lands —
 * there is never a window where the public site advertises the internal
 * `*.sites.<base>` fallback as canonical. (That window is how
 * `autopilot.sites.typeroll.com` leaked into `autopilot.se`'s sitemap +
 * canonical with index,follow.) Pre-DNS the fallback subdomain still serves
 * the build, but the hosting platform's zone-level response-header rule marks
 * every hosted fallback response `noindex, nofollow`. It is independent of
 * the per-site deploy runner, so a canonical pointing at the
 * not-yet-resolving domain is never crawled from the wrong host.
 */
export function isCanonicalReady(site: Pick<Site, 'domain'>): boolean {
  return !!site.domain;
}

/**
 * At-a-glance state of a site's own domain. This is what the dashboards show
 * where they used to show `Site.status`.
 *
 * Why not `Site.status`: that field was written once at site creation and
 * never advanced, so it reported sites serving real production traffic as
 * 'planning'. It was removed in 0.30.0. `domain_status` is maintained by the
 * domain lifecycle, so it tracks what's actually true.
 *
 * Distinct from `isCanonicalReady`, which asks "should the build bake this
 * domain in as canonical" (true as soon as a domain is *declared*, before
 * DNS resolves — deliberately). This asks the narrower question "is the
 * domain actually answering".
 */
export type DomainState = 'live' | 'pending' | 'failed' | 'none';

export function domainState(
  site: { domain?: string; domain_status?: string },
): DomainState {
  if (!site.domain) return 'none';
  switch (site.domain_status) {
    case 'verified':
    case 'live':
      return 'live';
    case 'failed':
      return 'failed';
    default:
      // Includes 'pending' and legacy docs with no domain_status at all: a
      // domain is declared but we have no confirmation it resolves.
      return 'pending';
  }
}

/** True when the site answers on its own domain. */
export function isServingOnOwnDomain(
  site: { domain?: string; domain_status?: string },
): boolean {
  return domainState(site) === 'live';
}

export const DOMAIN_STATE_LABEL: Record<DomainState, string> = {
  live: 'live',
  pending: 'DNS pending',
  failed: 'DNS failed',
  none: 'no domain',
};

export function publicUrlsFor(site: Site & { id: string }): PublicSiteUrls {
  const domain = (site as { domain?: string }).domain;
  const status = (site as { domain_status?: 'pending' | 'verified' | 'live' | 'failed' }).domain_status;
  const stagingUrl = (site as { staging_url?: string }).staging_url;
  const portalOrigin = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
  const baseDomain = (process.env.SITES_BASE_DOMAIN ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  // Prefer site.slug (writable), then the existing fallback_subdomain that
  // site-provisioning may have set at create time, then site.id as a
  // last-ditch label.
  const fallbackSubdomain = site.hosting_config?.fallback_subdomain;
  const slugLabel = (site as { slug?: string }).slug;
  let fallback: string | null = null;
  if (fallbackSubdomain) {
    // Already a fully-qualified host attached at provisioning.
    fallback = `https://${fallbackSubdomain}`;
  } else if (baseDomain) {
    fallback = `https://${slugLabel ?? site.id}.${baseDomain}`;
  }

  // Two distinct concepts, deliberately NOT conflated:
  //
  //   • CANONICAL (baked into the build's sitemap + <link rel=canonical>):
  //     the declared domain, immediately — see isCanonicalReady. That's what
  //     stops the internal *.sites fallback leaking into a public sitemap.
  //
  //   • production / live_url (what agents tell the customer to VISIT):
  //     only non-null once DNS is confirmed (verified/live/legacy). Surfacing
  //     the domain here before DNS resolves is the original autopilot.se bug —
  //     the agent sent the user to a domain that still pointed at their old
  //     site. So agents fall back to the preview/fallback URL until DNS lands.
  // Legacy compat is deliberately narrow: a missing status only counts as
  // verified when domain_verified_at proves DNS was once confirmed. A bare
  // domain with no lifecycle fields (written by paths that bypassed
  // requestDomain) was never registered on CF, so it must surface as
  // pending — telling an agent/customer to visit it is the original bug.
  const verifiedAt = (site as { domain_verified_at?: string }).domain_verified_at;
  const dnsVerified = !!domain
    && (status === 'verified' || status === 'live' || (status === undefined && !!verifiedAt));
  return {
    production:     dnsVerified && domain ? `https://${domain}` : null,
    // The declared domain whose DNS isn't confirmed yet: the canonical is
    // already baked to it, but it isn't reachable, so the UI prompts the
    // customer to point DNS and agents keep using the fallback.
    pending_domain: domain && !dnsVerified ? domain : null,
    domain_status:  domain ? (status ?? (verifiedAt ? 'live' : 'pending')) : null,
    fallback,
    staging: stagingUrl ?? null,
    preview_base: portalOrigin ? `${portalOrigin}/preview/${site.id}` : null,
  };
}
