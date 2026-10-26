/**
 * High-level "this site needs CF infra" workflows. Sits on top of
 * cloudflare-api.ts; owns the conventions (project naming, fallback
 * subdomain, DNS records) so callers (site create / domain update /
 * site delete) don't have to.
 *
 * Every function here degrades to a no-op when the CF credentials
 * aren't configured — keeps local dev + tests usable without faking
 * the whole CF API.
 */

import { randomBytes } from 'node:crypto';
import { CloudflareApi, CloudflareConflictError, pagesProjectNameForSite } from './cloudflare-api';
import { paths, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import {
  claimFallbackHostname,
  FallbackHostnameUnavailableError,
  releaseFallbackHostname,
  type FallbackHostnameOwner,
} from './fallback-hostnames';

export { FallbackHostnameUnavailableError } from './fallback-hostnames';

export interface ProvisionResult {
  /** The CF Pages project we created (or reused) for this site. */
  pagesProject: string;
  /** Fully-qualified preview subdomain we attached to it, or null when
   *  no SITES_BASE_DOMAIN is configured. */
  fallbackSubdomain: string | null;
}

export function needsFallbackProvisioning(
  site: { slug?: string; publishing_mode?: Site['publishing_mode']; hosting_config?: { fallback_subdomain?: string; pages_project?: string } },
  requestedSlug: string,
): boolean {
  // Customer Git sites publish through the organization's own hosting; the
  // platform never provisions a fallback hostname for them.
  if (site.publishing_mode === 'customer_git') return false;
  return site.slug !== requestedSlug ||
    !site.hosting_config?.fallback_subdomain ||
    !site.hosting_config?.pages_project;
}

function cfFromEnv(): CloudflareApi | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return null;
  return new CloudflareApi({ accountId, apiToken });
}

/**
 * Run at site-creation. Idempotent — safe to re-run if a previous
 * attempt partially succeeded.
 *
 * Produces:
 *   1. A CF Pages project named after the site.
 *   2. (If SITES_BASE_DOMAIN is set) a `<slug>.{base}` CNAME pointing
 *      at the project, plus the corresponding custom-domain record on
 *      the project itself. The customer can use this URL to preview
 *      their site before pointing their real domain at us.
 */
export async function provisionSiteHosting(orgId: string, siteId: string): Promise<ProvisionResult | null> {
  if ((await getStore().getDoc<Site>(paths.site(orgId, siteId)))?.publishing_mode === 'customer_git') return null;
  const cf = cfFromEnv();
  if (!cf) return null;

  const pagesProject = pagesProjectNameForSite(orgId, siteId);
  await cf.createPagesProject(pagesProject);

  const base = process.env.SITES_BASE_DOMAIN; // e.g. "sites.typeroll.com"
  if (!base) {
    return { pagesProject, fallbackSubdomain: null };
  }

  // Build the fallback subdomain. We prefer the site id as the label —
  // it's already user-influenced (slugify of site name) so the URL is
  // somewhat memorable while remaining safely DNS-valid. Site ids are
  // unique per organization only, so the label is claimed platform-wide;
  // when another site holds it, a random suffix makes it unique.
  const owner = { orgId, siteId };
  const label = dnsLabel(siteId);
  const candidates = [label, ...Array.from({ length: 3 }, () => `${label.slice(0, 48).replace(/-+$/, '')}-${randomBytes(3).toString('hex')}`)];
  for (const candidate of candidates) {
    const fallback = `${candidate}.${base}`;
    try {
      await bindFallbackHostname(cf, base, pagesProject, fallback, owner);
      return { pagesProject, fallbackSubdomain: fallback };
    } catch (e) {
      if (e instanceof FallbackHostnameUnavailableError) continue;
      throw e;
    }
  }
  throw new FallbackHostnameUnavailableError(`${label}.${base}`, 'No free fallback hostname could be claimed for this site.');
}

/**
 * Claim `host` for the site, then attach it to the site's Pages project and
 * point its CNAME there. Refuses (FallbackHostnameUnavailableError) when
 * another site holds the claim, when the zone already has a CNAME for the
 * host that points at a different target, or when another Pages project
 * holds the domain. Hostnames from before the claim registry are covered by
 * the two Cloudflare checks. A claim this call created is released again
 * when binding fails, so a failed attempt never strands a label.
 */
async function bindFallbackHostname(
  cf: CloudflareApi,
  base: string,
  pagesProject: string,
  host: string,
  owner: FallbackHostnameOwner,
  prepare?: () => Promise<void>,
): Promise<void> {
  const target = `${pagesProject}.pages.dev`;
  const claim = await claimFallbackHostname(host, owner);
  try {
    await prepare?.();
    // The zone is the registrable-domain portion of `base`. For
    // sites.typeroll.com, that's typeroll.com.
    const zoneId = await cf.getZoneId(inferZoneName(base));
    // Check DNS before attaching: attaching first would bind a hostname
    // whose DNS belongs to someone else to this project.
    const existing = await cf.findDnsRecords(zoneId, 'CNAME', host);
    if (existing.some((record) => record.content !== target)) {
      throw new FallbackHostnameUnavailableError(host, `${host} already points to another site.`);
    }
    // Two-step coupling: attach the domain to the Pages project (so CF
    // serves the project's content under that hostname), and create the
    // CNAME in the zone (so DNS resolves). Both are idempotent for this
    // project and refuse to take over another project's hostname.
    await cf.attachCustomDomain(pagesProject, host);
    await cf.upsertDnsRecord({
      zoneId,
      type: 'CNAME',
      name: host,
      // CF Pages serves the project at <project>.pages.dev. We CNAME to
      // that; CF takes care of routing.
      content: target,
      proxied: false,
    });
  } catch (e) {
    if (claim.created) await releaseFallbackHostname(host, owner).catch(() => {});
    if (e instanceof CloudflareConflictError) throw new FallbackHostnameUnavailableError(host, `${host} is already used by another site.`);
    throw e;
  }
}

/** A DNS-safe label from a site id. */
function dnsLabel(siteId: string): string {
  const label = siteId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
  return label || 'site';
}

/**
 * Run when a customer sets / changes their real domain on the Settings
 * page. Attaches the domain to the CF Pages project; the customer is
 * still responsible for pointing their DNS at `<project>.pages.dev`.
 *
 * Returns DNS instructions to show the customer.
 */
export interface AttachDomainResult {
  ok: boolean;
  cname_target?: string;
  message: string;
}
export async function attachCustomerDomain(
  pagesProject: string,
  domain: string,
): Promise<AttachDomainResult> {
  const cf = cfFromEnv();
  if (!cf) {
    return {
      ok: false,
      message: 'Cloudflare credentials not configured on this portal — can\'t auto-attach domain.',
    };
  }
  try {
    await cf.attachCustomDomain(pagesProject, domain);
    return {
      ok: true,
      cname_target: `${pagesProject}.pages.dev`,
      message: `Domain attached. Point your DNS — CNAME ${domain} → ${pagesProject}.pages.dev — to finish. SSL provisioning takes 1–10 minutes after DNS resolves.`,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Re-provision the fallback subdomain when the customer changes their
 * site slug. Attaches the new `{slug}.{base}` to the CF Pages project,
 * creates the CNAME, and returns the new fully-qualified host. Keeps
 * the OLD fallback subdomain attached so bookmarks/SEO survive — the
 * customer can manually clean up the old one from the portal later.
 *
 * Returns null when CF / SITES_BASE_DOMAIN isn't configured (self-host
 * without the SaaS wildcard zone). Caller persists the new value to
 * Site.hosting_config.fallback_subdomain.
 */
export async function reprovisionFallbackSubdomain(args: {
  orgId: string;
  siteId: string;
  newSlug: string;
}): Promise<{ fallbackSubdomain: string; cnameTarget: string; pagesProject: string } | null> {
  const cf = cfFromEnv();
  if (!cf) return null;
  const base = process.env.SITES_BASE_DOMAIN;
  if (!base) return null;
  if ((await getStore().getDoc<Site>(paths.site(args.orgId, args.siteId)))?.publishing_mode === 'customer_git') return null;

  const pagesProject = pagesProjectNameForSite(args.orgId, args.siteId);
  const newHost = `${args.newSlug}.${base}`;
  const cnameTarget = `${pagesProject}.pages.dev`;

  // Claims the hostname platform-wide, then attaches + CNAMEs it. Re-running
  // for a host this site already holds is a no-op; a host another site
  // holds throws FallbackHostnameUnavailableError and nothing is changed.
  await bindFallbackHostname(cf, base, pagesProject, newHost, { orgId: args.orgId, siteId: args.siteId }, async () => {
    // Self-heal: ensure the Pages project exists before attaching a domain
    // to it. Sites created through /api/sites/create already have one, but
    // sites bootstrapped via fixtures/Firestore-seed don't — and the slug
    // change is the first time we'd notice. createPagesProject is idempotent
    // (409 → returns existing).
    await cf.createPagesProject(pagesProject);
  });
  return { fallbackSubdomain: newHost, cnameTarget, pagesProject };
}

/**
 * Run on site delete. Removes the CF Pages project AND the fallback
 * subdomain CNAME we created. Customer domains attached during the
 * site's life are also cleaned up when the project is deleted.
 *
 * Best-effort: errors are swallowed so a partial CF state doesn't
 * block the doc deletion.
 */
export async function deprovisionSiteHosting(orgId: string, siteId: string, fallbackSubdomain?: string): Promise<void> {
  const cf = cfFromEnv();
  if (!cf) return;
  const pagesProject = pagesProjectNameForSite(orgId, siteId);
  try {
    await cf.deletePagesProject(pagesProject);
  } catch { /* ignore */ }
  if (fallbackSubdomain) {
    const base = process.env.SITES_BASE_DOMAIN;
    if (base) {
      try {
        const zoneId = await cf.getZoneId(inferZoneName(base));
        // Only this site's own record: never delete a CNAME that routes the
        // hostname to another site's project.
        await cf.deleteDnsRecord(zoneId, fallbackSubdomain, 'CNAME', `${pagesProject}.pages.dev`);
        // The label becomes claimable again only once its record is gone.
        await releaseFallbackHostname(fallbackSubdomain, { orgId, siteId });
      } catch { /* ignore */ }
    }
  }
}

/** Drop everything left of the last two labels: e.g.
 *  "sites.typeroll.com" → "typeroll.com",
 *  "foo.bar.example.co.uk" → "co.uk" (which is a known limitation —
 *  we don't have a public-suffix-list dependency, but for our actual
 *  use of *.sites.typeroll.com it's fine). */
function inferZoneName(host: string): string {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}
