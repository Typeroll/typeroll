// Custom-domain lifecycle service. Wraps the Cloudflare Pages domain
// API and persists state to the Site doc. See docs/domain-lifecycle-plan.md
// for the design.
//
// Apex/www pair invariant — read this before changing any flow here.
// ---------------------------------------------------------------
// Cloudflare Pages routes by Host header against the project's
// registered-domain list. Registering only `example.com` makes
// `www.example.com` return 522 (and vice versa) because the project
// silently isn't authoritative for the other variant. The autopilot.se
// field report is what triggered this rewrite — see the comment thread
// on Site.domain_alias in @typeroll/shared.
//
// Rule: every time the customer adds a hostname that's part of an
// apex/www pair, the platform registers BOTH on Pages and picks one as
// canonical with a 301 from the other. Subdomain hostnames
// (`app.example.com`) stay single-domain. The classifier lives in
// domain-pair.ts.
//
// State on Site doc when a pair is registered:
//   domain                       canonical hostname (user-facing)
//   domain_alias                 the variant that 301s to canonical
//   domain_canonical             'apex' | 'www' — drives which is which
//   domain_status                canonical's verification state on CF
//   domain_alias_status          alias variant's verification state on CF
//   domain_dns_target            CNAME / ALIAS target both variants point at
//
// Verbs:
//
//   requestDomain(orgId, siteId, hostname, options?)
//     → classifies input; for an apex/www pair registers BOTH on CF
//       and stores canonical + alias. Subdomains stay single-domain.
//
//   pollDomainStatus(orgId, siteId)
//     → polls CF for canonical AND alias (when present). Overall site
//       status = worst-of-two (one failure means whole pair shows
//       failed; one still pending blocks the verified gate).
//
//   activateDomain(orgId, siteId)
//     → precondition: domain_status === 'verified' AND (no alias OR
//       domain_alias_status === 'verified'). Refuses to activate a
//       half-registered pair — that's the autopilot.se 522 trap.
//
//   removeDomain(orgId, siteId)
//     → removes BOTH custom domains from CF (best-effort on alias),
//       clears all domain_* fields.
//
// Callers must have already passed `requireSiteAccess` +
// `requirePermission(ctx, 'admin')` — these mutations aren't an
// editor-level action.
//
// `getDomainAdapter()` returns null when CF isn't configured on this
// portal (R2_-only / self-hosted-without-CF deployments). The service
// methods throw in that case rather than silently writing a state the
// portal can't follow up on; callers should surface a sensible 503.

import { paths, type Site } from '@typeroll/shared';
import { getStore } from './datastore';
import { CloudflareApi, pagesProjectNameForSite, type CustomDomainStatus } from './hosting/cloudflare-api';
import { classifyHostname, isValidHostname, normalizeHostname, pickCanonical } from './domain-pair';

export class DomainServiceError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'DomainServiceError';
  }
}

/** Returns the CF API client + the project name for this site, or null when
 *  Cloudflare isn't configured at all. */
function getCloudflareForSite(orgId: string, siteId: string): { api: CloudflareApi; project: string } | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return null;
  return {
    api: new CloudflareApi({ accountId, apiToken }),
    project: pagesProjectNameForSite(orgId, siteId),
  };
}

// normalizeHostname + isValidHostname live in domain-pair.ts (pure
// helpers shared with the pair classifier). Re-exported here so external
// callers that imported them from this module keep working.
export { normalizeHostname, isValidHostname };

/** Map a CF status to our lifecycle state. */
function mapCloudflareStatus(s: CustomDomainStatus['status']):
  { status: 'pending' | 'verified' | 'failed'; reason?: string } {
  switch (s) {
    case 'active':      return { status: 'verified' };
    case 'pending':     return { status: 'pending' };
    case 'deactivated': return { status: 'failed', reason: 'Cloudflare reports the domain is deactivated.' };
    case 'blocked':     return { status: 'failed', reason: 'Cloudflare blocked the domain — usually a policy issue. Contact support.' };
    case 'error':       return { status: 'failed', reason: 'Cloudflare reports an unrecoverable error. Re-check DNS and try again.' };
    default:            return { status: 'pending' };
  }
}

export interface DomainStateResponse {
  hostname: string;
  status: 'pending' | 'verified' | 'live' | 'failed';
  dns_target: string;
  verified_at: string | null;
  failure_reason: string | null;
  /** When the canonical hostname has a sister variant registered on the
   *  same Pages project, this carries its hostname + per-variant status.
   *  Null when the site is a single-domain subdomain registration. */
  alias?: {
    hostname: string;
    status: 'pending' | 'verified' | 'live' | 'failed';
    failure_reason: string | null;
  } | null;
  /** Which variant is treated as canonical. Drives both the UI label
   *  ("apex / www") and the direction of the cross-host 301. Undefined
   *  for subdomain-only registrations. */
  canonical_kind?: 'apex' | 'www';
}

import type { CanonicalPick } from './domain-pair';

interface RequestDomainOptions {
  /**
   * Which variant of an apex/www pair should be canonical. Defaults to
   * `'apex'` (modern best practice — Google's John Mueller has
   * recommended it since 2018; users who type `example.com` get the
   * same URL bar as users who type `www.example.com`).
   * Ignored for subdomain inputs.
   */
  prefer?: 'apex' | 'www';
}

function dnsTargetForProject(project: string): string {
  return `${project}.pages.dev`;
}

async function loadSite(orgId: string, siteId: string): Promise<Site & { id: string }> {
  const site = await getStore().getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new DomainServiceError(`Site ${siteId} not found`, 404);
  return { ...site, id: siteId };
}

function toResponse(site: Site): DomainStateResponse | null {
  if (!site.domain) return null;
  const alias: DomainStateResponse['alias'] = site.domain_alias
    ? {
        hostname: site.domain_alias,
        status: site.domain_alias_status ?? 'pending',
        failure_reason: site.domain_alias_failure_reason ?? null,
      }
    : null;
  return {
    hostname: site.domain,
    // Legacy compat, deliberately narrow: a missing domain_status only
    // counts as 'live' when a verification timestamp proves DNS was once
    // confirmed. A bare `domain` with no lifecycle fields at all is NOT
    // live — that shape is produced by writes that bypass requestDomain
    // (e.g. the pre-fix site-creation form, v1 PATCH), where the domain
    // was never registered on Cloudflare Pages, let alone verified.
    status: site.domain_status ?? (site.domain_verified_at ? 'live' : 'pending'),
    dns_target: site.domain_dns_target ?? '',
    verified_at: site.domain_verified_at ?? null,
    failure_reason: site.domain_failure_reason ?? null,
    alias,
    canonical_kind: site.domain_canonical,
  };
}

/**
 * Attach a hostname as a custom domain to this site.
 *
 * Apex/www pair handling — the autopilot.se "522 on apex" fix:
 *
 * If `rawHostname` resolves to an apex (`example.com`) or www
 * (`www.example.com`) hostname, this function registers BOTH variants
 * on the Pages project in a single atomic-ish operation:
 *
 *   1. Pick canonical based on `options.prefer` (default 'apex')
 *   2. Call attachCustomDomain(canonical). If this fails the whole
 *      operation fails — no site doc write, no half-state.
 *   3. Call attachCustomDomain(alias). If this fails we roll back
 *      step 2 (best-effort removeCustomDomain) and surface the alias
 *      error. The user sees "couldn't register www" rather than
 *      ending up in the silent 522 state.
 *   4. Write Site doc: domain=canonical, domain_alias=alias,
 *      domain_canonical='apex'|'www'.
 *
 * If `rawHostname` is a non-pair subdomain (`app.example.com`), only
 * that hostname is registered (legacy single-domain flow).
 *
 * Idempotent on identical inputs. Calling with a hostname when a
 * different domain already attached throws — caller removes first.
 */
export async function requestDomain(
  orgId: string,
  siteId: string,
  rawHostname: string,
  options: RequestDomainOptions = {},
): Promise<DomainStateResponse> {
  const classification = classifyHostname(rawHostname);
  if (!classification.hostname || classification.hostname === '' || (classification.kind === 'subdomain' && !classification.apex && !isValidHostname(classification.hostname))) {
    throw new DomainServiceError(
      `"${rawHostname}" doesn't look like a valid hostname (expected something like "www.example.com").`,
      400,
    );
  }

  const cf = getCloudflareForSite(orgId, siteId);
  if (!cf) {
    throw new DomainServiceError(
      'Cloudflare is not configured on this portal — set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to enable custom-domain management.',
      503,
    );
  }

  const prefer = options.prefer ?? 'apex';
  const pick = pickCanonical(rawHostname, prefer);

  const site = await loadSite(orgId, siteId);
  // Already-attached check covers both the canonical and the alias —
  // we don't want a customer who typed "www.example.com" yesterday
  // (which registered apex+www as the pair) and "example.com" today
  // to get a 409. Same pair → idempotent return.
  const existingPairMatches =
    site.domain === pick.canonical &&
    (pick.alias ? site.domain_alias === pick.alias : !site.domain_alias);
  if (site.domain && !existingPairMatches) {
    throw new DomainServiceError(
      `This site already has a custom domain (${site.domain}${site.domain_alias ? ` + ${site.domain_alias}` : ''}). Remove it first before adding a different one.`,
      409,
    );
  }
  if (existingPairMatches && site.domain_status && site.domain_status !== 'failed') {
    return toResponse(site)!;
  }

  // Step 1+2: register canonical first. Any error from CF here aborts
  // before we touch the doc.
  await cf.api.attachCustomDomain(cf.project, pick.canonical);

  // Step 3: register alias. Roll back canonical on failure so the user
  // doesn't end up with a half-registered pair (= the 522 trap on the
  // unregistered variant).
  if (pick.alias) {
    try {
      await cf.api.attachCustomDomain(cf.project, pick.alias);
    } catch (e) {
      // Best-effort rollback. If this fails too we surface the original
      // alias error — at least the user has actionable info, and a
      // subsequent retry will see the canonical already-attached as
      // 409 (which attachCustomDomain treats as success — idempotent).
      try {
        await cf.api.removeCustomDomain(cf.project, pick.canonical);
      } catch {
        /* swallow — original error is what the user needs to see */
      }
      const reason = e instanceof Error ? e.message : String(e);
      throw new DomainServiceError(
        `Registered ${pick.canonical} but couldn't register the sister hostname ${pick.alias} on Cloudflare: ${reason}. Both variants must be registered or one will return 522 — please retry.`,
        502,
      );
    }
  }

  // Step 4: write the Site doc atomically (single updateDoc call).
  const update: Partial<Site> = {
    domain: pick.canonical,
    domain_status: 'pending',
    domain_added_at: site.domain_added_at ?? new Date().toISOString(),
    domain_dns_target: dnsTargetForProject(cf.project),
    domain_failure_reason: undefined,
    // Pair fields — explicitly cleared when there's no alias (so a
    // re-add that goes from pair → subdomain doesn't carry stale state).
    domain_alias: pick.alias ?? undefined,
    domain_alias_status: pick.alias ? 'pending' : undefined,
    domain_alias_failure_reason: undefined,
    domain_canonical: pick.alias ? (classification.kind === 'www' && prefer === 'www' ? 'www' : prefer) : undefined,
  };
  await getStore().updateDoc(paths.site(orgId, siteId), update as Record<string, unknown>);

  return responseFromPick(pick, dnsTargetForProject(cf.project), prefer);
}

function responseFromPick(pick: CanonicalPick, dnsTarget: string, prefer: 'apex' | 'www'): DomainStateResponse {
  return {
    hostname: pick.canonical,
    status: 'pending',
    dns_target: dnsTarget,
    verified_at: null,
    failure_reason: null,
    alias: pick.alias
      ? { hostname: pick.alias, status: 'pending', failure_reason: null }
      : null,
    canonical_kind: pick.alias ? prefer : undefined,
  };
}

/**
 * Refresh the lifecycle state from Cloudflare. Returns the updated
 * response. Idempotent — calling once a minute is fine.
 *
 * If status was `live`, polling will only flip back to `verified` if CF
 * starts reporting something other than `active` (rare; usually means
 * the customer removed the CNAME themselves). The customer would then
 * need to fix DNS and re-poll.
 */
export async function pollDomainStatus(
  orgId: string,
  siteId: string,
): Promise<DomainStateResponse> {
  const cf = getCloudflareForSite(orgId, siteId);
  if (!cf) {
    throw new DomainServiceError(
      'Cloudflare is not configured on this portal.',
      503,
    );
  }
  const site = await loadSite(orgId, siteId);
  if (!site.domain) {
    throw new DomainServiceError('No custom domain is attached to this site.', 404);
  }

  const cfStatus = await cf.api.getCustomDomainStatus(cf.project, site.domain);
  if (!cfStatus) {
    // CF doesn't know about this domain — it was probably removed out-of-band.
    // Drop our record so the site UI doesn't show a phantom.
    await getStore().updateDoc(paths.site(orgId, siteId), {
      domain: undefined,
      domain_status: undefined,
      domain_added_at: undefined,
      domain_verified_at: undefined,
      domain_dns_target: undefined,
      domain_failure_reason: undefined,
      domain_alias: undefined,
      domain_alias_status: undefined,
      domain_alias_failure_reason: undefined,
      domain_canonical: undefined,
    });
    throw new DomainServiceError('Cloudflare no longer recognises this domain attachment. The record has been cleared — re-add the domain to start over.', 410);
  }

  const mapped = mapCloudflareStatus(cfStatus.status);
  const update: Partial<Site> = {};

  // Self-heal a missing DNS target. Domains attached before the CF project was
  // resolvable (or via a path that didn't stamp it) leave domain_dns_target
  // empty — which renders a broken "CNAME @ → " with no value in the UI. A
  // poll is the natural place to backfill it since we already have cf.project.
  if (!site.domain_dns_target) {
    update.domain_dns_target = dnsTargetForProject(cf.project);
  }

  // Preserve `live` if the customer already activated and CF still reports
  // active. Otherwise the mapped CF status wins.
  if (site.domain_status === 'live' && mapped.status === 'verified') {
    // No state change needed.
  } else if (mapped.status !== site.domain_status) {
    update.domain_status = mapped.status;
    if (mapped.status === 'verified') {
      update.domain_verified_at = new Date().toISOString();
      update.domain_failure_reason = undefined;
    } else if (mapped.status === 'failed') {
      update.domain_failure_reason = mapped.reason ?? 'Unknown error from Cloudflare.';
    } else {
      update.domain_failure_reason = undefined;
    }
  }

  // Poll the alias variant if there is one. Same mapping, written to
  // domain_alias_status. The overall site doesn't go `live` until BOTH
  // are verified (enforced by activateDomain) — but we surface the per-
  // variant status independently so the UI can show "apex verified, www
  // pending" while the customer fixes one DNS record at a time.
  if (site.domain_alias) {
    const aliasCfStatus = await cf.api.getCustomDomainStatus(cf.project, site.domain_alias);
    if (!aliasCfStatus) {
      // Alias was removed out-of-band — surface as a pair-level failure
      // rather than silently losing the alias field. The user needs to
      // know the pair is broken.
      update.domain_alias_status = 'failed';
      update.domain_alias_failure_reason =
        `Cloudflare no longer recognises ${site.domain_alias}. The pair is broken — remove and re-add the domain to fix.`;
    } else {
      const aliasMapped = mapCloudflareStatus(aliasCfStatus.status);
      if (aliasMapped.status !== site.domain_alias_status) {
        update.domain_alias_status = aliasMapped.status;
        if (aliasMapped.status === 'failed') {
          update.domain_alias_failure_reason = aliasMapped.reason ?? 'Unknown error from Cloudflare.';
        } else {
          update.domain_alias_failure_reason = undefined;
        }
      }
    }
  }

  if (Object.keys(update).length > 0) {
    await getStore().updateDoc(paths.site(orgId, siteId), update as Record<string, unknown>);
  }

  const fresh = await loadSite(orgId, siteId);
  return toResponse(fresh)!;
}

/**
 * Flip the customer-controlled gate from `verified` → `live`. This is
 * what makes the custom domain show up as `production` in API responses.
 *
 * Precondition: the current status must be `verified` (or already
 * `live`, in which case this is a no-op). Calling on `pending` or
 * `failed` throws.
 */
export async function activateDomain(
  orgId: string,
  siteId: string,
): Promise<DomainStateResponse> {
  const site = await loadSite(orgId, siteId);
  if (!site.domain) {
    throw new DomainServiceError('No custom domain is attached to this site.', 404);
  }
  if (site.domain_status === 'live') {
    return toResponse(site)!;
  }
  if (site.domain_status !== 'verified') {
    throw new DomainServiceError(
      `Cannot activate a domain whose status is "${site.domain_status ?? 'unknown'}". The domain must be verified by Cloudflare first.`,
      412,
    );
  }
  // Pair-aware: if there's an alias, it MUST also be verified before
  // activation. Going live with only one variant ready is the exact
  // failure mode this rewrite exists to prevent — the user would see
  // their site work in their own browser (they typed the canonical) but
  // every link sent to a customer who typed the other variant 522s.
  if (site.domain_alias && site.domain_alias_status !== 'verified') {
    throw new DomainServiceError(
      `Cannot activate while the sister hostname ${site.domain_alias} is "${site.domain_alias_status ?? 'unknown'}". Both apex and www must be verified — point DNS at ${site.domain_dns_target} for both, then re-poll.`,
      412,
    );
  }
  await getStore().updateDoc(paths.site(orgId, siteId), {
    domain_status: 'live',
    // Flip the alias to 'live' as well so subsequent reads show a
    // consistent "both live" state. The alias status mirrors canonical
    // once the customer's clicked Activate — the cross-host 301 in
    // _redirects is what actually does the work.
    ...(site.domain_alias ? { domain_alias_status: 'live' as const } : {}),
  });
  const fresh = await loadSite(orgId, siteId);
  return toResponse(fresh)!;
}

/**
 * Detach the custom domain from this site. Calls Cloudflare to remove
 * the binding, then clears every domain_* field. Safe to call when the
 * site has no domain attached (no-op).
 */
export async function removeDomain(
  orgId: string,
  siteId: string,
): Promise<{ ok: true }> {
  const site = await loadSite(orgId, siteId);
  if (!site.domain) return { ok: true };

  const cf = getCloudflareForSite(orgId, siteId);
  if (cf) {
    // CF removal is best-effort on the alias — if alias removal fails
    // (e.g. it was already removed out-of-band), we still want to
    // remove the canonical and clear the doc. Canonical removal must
    // succeed though; if it errors we propagate so the UI shows the
    // failure rather than leaving a phantom CF binding.
    if (site.domain_alias) {
      try {
        await cf.api.removeCustomDomain(cf.project, site.domain_alias);
      } catch (e) {
        console.warn(
          `[domain] removeCustomDomain alias ${site.domain_alias} failed (continuing with canonical): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    await cf.api.removeCustomDomain(cf.project, site.domain);
  }

  await getStore().updateDoc(paths.site(orgId, siteId), {
    domain: undefined,
    domain_status: undefined,
    domain_added_at: undefined,
    domain_verified_at: undefined,
    domain_dns_target: undefined,
    domain_failure_reason: undefined,
    domain_alias: undefined,
    domain_alias_status: undefined,
    domain_alias_failure_reason: undefined,
    domain_canonical: undefined,
  });
  return { ok: true };
}

/** Read-only accessor — returns the current domain state without
 *  contacting Cloudflare. Useful for UI hydration and the v1 GET endpoint. */
export async function getDomainState(orgId: string, siteId: string): Promise<DomainStateResponse | null> {
  const site = await loadSite(orgId, siteId);
  return toResponse(site);
}

/**
 * Best-effort domain declaration for the site-creation flow. Routes the
 * domain typed in the "create site" form through the exact same
 * domain-first pipeline as DomainManager (CF Pages registration, apex/www
 * pair handling, status 'pending' + DNS instructions) — site creation
 * itself must never fail because of the domain, so every error degrades:
 *
 *   - invalid hostname (400)        → domain dropped entirely; the user
 *                                     adds a correct one from Settings.
 *   - CF unconfigured / CF error    → intent recorded as `failed` with a
 *                                     reason the UI surfaces. `failed`
 *                                     (not `pending`) is what keeps a
 *                                     later requestDomain retry from
 *                                     short-circuiting on the idempotency
 *                                     gate without ever touching CF.
 *
 * No path through here can leave the site looking 'live'/'verified'.
 */
export async function declareDomainAtCreation(
  orgId: string,
  siteId: string,
  rawHostname: string,
): Promise<void> {
  try {
    await requestDomain(orgId, siteId, rawHostname);
    return;
  } catch (e) {
    if (e instanceof DomainServiceError && e.status === 400) {
      console.warn(`[create-site] dropped invalid domain "${rawHostname}" for ${siteId}: ${e.message}`);
      return;
    }
    const reason = e instanceof Error ? e.message : String(e);
    const pick = pickCanonical(rawHostname, 'apex');
    await getStore().updateDoc(paths.site(orgId, siteId), {
      domain: pick.canonical,
      domain_status: 'failed',
      domain_added_at: new Date().toISOString(),
      domain_failure_reason:
        `The domain was saved but could not be registered with Cloudflare Pages during site creation: ${reason}`,
      domain_alias: pick.alias ?? undefined,
      domain_alias_status: pick.alias ? ('failed' as const) : undefined,
      domain_alias_failure_reason: undefined,
      domain_canonical: pick.alias ? ('apex' as const) : undefined,
    } as Record<string, unknown>);
    console.error(`[create-site] CF domain registration failed for ${siteId} (${pick.canonical}):`, e);
  }
}
