// Custom-domain lifecycle of hosted sites (`publishing_mode: hosted`).
//
// Every other site publishes through its organization's accounts and manages
// its website and media hosts in Publishing
// (/api/v1/sites/{siteId}/publishing/domains); these verbs refuse such a site
// with a 409 that names that flow.
//
// Apex/www pair invariant: every time a hostname that is part of an apex/www
// pair is added, both are registered and one is picked as canonical, with a
// 301 from the other. Subdomain hostnames (`app.example.com`) stay
// single-domain. The classifier lives in domain-pair.ts.
//
// State on the Site doc when a pair is registered:
//   domain                       canonical hostname (user-facing)
//   domain_alias                 the variant that 301s to canonical
//   domain_canonical             'apex' | 'www' — drives which is which
//   domain_status                canonical's verification state
//   domain_alias_status          alias variant's verification state
//   domain_dns_target            CNAME / ALIAS target both variants point at
//
// Callers must have already passed `requireSiteAccess` +
// `requirePermission(ctx, 'admin')` — these mutations aren't an
// editor-level action.

import { paths, type Site } from '@typeroll/shared';
import { getStore } from './datastore';
import { classifyHostname, isValidHostname, normalizeHostname, pickCanonical } from './domain-pair';
import { ConnectionError } from './publishing/connections';
import { hostingSiteRef, siteHosting, HOSTED_MODE, type HostingDomainStatus } from './publishing/site-hosting';

export class DomainServiceError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'DomainServiceError';
  }
}

// normalizeHostname + isValidHostname live in domain-pair.ts (pure
// helpers shared with the pair classifier). Re-exported here so external
// callers that imported them from this module keep working.
export { normalizeHostname, isValidHostname };

export interface DomainStateResponse {
  hostname: string;
  status: 'pending' | 'verified' | 'live' | 'failed';
  dns_target: string;
  verified_at: string | null;
  failure_reason: string | null;
  /** When the canonical hostname has a sister variant registered, this
   *  carries its hostname + per-variant status. Null when the site is a
   *  single-domain subdomain registration. */
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

interface RequestDomainOptions {
  /**
   * Which variant of an apex/www pair should be canonical. Defaults to
   * `'apex'`. Ignored for subdomain inputs.
   */
  prefer?: 'apex' | 'www';
}

const CUSTOMER_PUBLISHING_DOMAINS = 'Manage website and media hosts in Publishing using /api/v1/sites/{siteId}/publishing/domains. Save future hosts, verify the candidate, then approve the traffic switch.';

type HostedDomainSite = Site & { id: string };

/** The hosted site, or a refusal naming the Publishing domains flow every other site uses. */
async function loadSite(orgId: string, siteId: string): Promise<HostedDomainSite> {
  const site = await getStore().getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new DomainServiceError(`Site ${siteId} not found`, 404);
  if (site.publishing_mode !== HOSTED_MODE) throw new DomainServiceError(CUSTOMER_PUBLISHING_DOMAINS, 409);
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
    // A missing domain_status only counts as 'live' when a verification
    // timestamp proves DNS was once confirmed.
    status: site.domain_status ?? (site.domain_verified_at ? 'live' : 'pending'),
    dns_target: site.domain_dns_target ?? '',
    verified_at: site.domain_verified_at ?? null,
    failure_reason: site.domain_failure_reason ?? null,
    alias,
    canonical_kind: site.domain_canonical,
  };
}

/**
 * Attach a hostname as a custom domain to a hosted site. For an apex or www
 * hostname both variants are registered (see the pair invariant above).
 * Idempotent on identical inputs. Calling with a hostname when a different
 * domain is already attached throws — the caller removes it first.
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
  const site = await loadSite(orgId, siteId);
  return hostedRequestDomain(orgId, site, rawHostname, options.prefer ?? 'apex', classification.kind);
}

/** Refresh the lifecycle state from the hosting service. Only on request, never in the background. */
export async function pollDomainStatus(orgId: string, siteId: string): Promise<DomainStateResponse> {
  return hostedPollDomainStatus(orgId, await loadSite(orgId, siteId));
}

/**
 * Flip the gate from `verified` → `live`: launch the site on its custom
 * domain. Already `live` is a no-op; `pending` or `failed` throws.
 */
export async function activateDomain(orgId: string, siteId: string): Promise<DomainStateResponse> {
  const site = await loadSite(orgId, siteId);
  if (!site.domain) {
    throw new DomainServiceError('No custom domain is attached to this site.', 404);
  }
  if (site.domain_status === 'live') return toResponse(site)!;
  return hostedActivateDomain(orgId, site);
}

/** Detach the custom domain. Safe to call when the site has no domain attached (no-op). */
export async function removeDomain(orgId: string, siteId: string): Promise<{ ok: true }> {
  const site = await loadSite(orgId, siteId);
  if (!site.domain) return { ok: true };
  return hostedRemoveDomain(orgId, site);
}

/** Read-only accessor — returns the current domain state without contacting the hosting service. */
export async function getDomainState(orgId: string, siteId: string): Promise<DomainStateResponse | null> {
  return toResponse(await loadSite(orgId, siteId));
}

/**
 * Best-effort domain declaration for the site-creation flow: site creation
 * itself never fails because of the domain. A hosted site registers it with
 * the hosting service; every other site saves it as the desired website host
 * of its Publishing domains.
 */
export async function declareDomainAtCreation(
  orgId: string,
  siteId: string,
  rawHostname: string,
): Promise<void> {
  const site = await getStore().getDoc<Site>(paths.site(orgId, siteId));
  if (site?.publishing_mode === HOSTED_MODE) {
    try { await requestDomain(orgId, siteId, rawHostname); }
    catch (e) { console.warn(`[create-site] hosted domain "${rawHostname}" was not added for ${siteId}: ${e instanceof Error ? e.message : String(e)}`); }
    return;
  }
  const { getSiteDomains, saveSiteDomains } = await import('./publishing/domain-config');
  const config = await getSiteDomains(orgId, siteId);
  await saveSiteDomains(orgId, siteId, { revision: config.revision, website_host: rawHostname, dns_mode: 'automatic' });
}

// ---------------------------------------------------------------------------
// Hosted hostnames through the bound hosting service (publishing/site-hosting).
//
// The service's domain state is the source of truth; the site document
// mirrors it in the same `domain*` fields, so URLs and existing callers read
// hosted sites like any other:
//   pending   the hostname waits for DNS or its certificate
//   verified  Cloudflare serves it with a valid certificate
//   live      activated: launched with this hostname as the primary
//   failed    Cloudflare blocked the hostname
// Status is read from the service only when a caller asks (poll), never in
// the background. Without a bound service every verb answers 404.
// ---------------------------------------------------------------------------

async function hosted<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof ConnectionError) throw new DomainServiceError(error.message, error.status);
    throw error;
  }
}

function hostedState(status: HostingDomainStatus, launchedPrimary: boolean): { status: 'pending' | 'verified' | 'live' | 'failed'; reason: string | null } {
  if (status.action === 'blocked') return { status: 'failed', reason: status.errors.join(' ') || 'Cloudflare blocked this hostname. Contact support.' };
  if (status.live) return { status: launchedPrimary ? 'live' : 'verified', reason: null };
  return { status: 'pending', reason: status.errors.length ? status.errors.join(' ') : null };
}

/** Write the mirror of the hosted hostnames onto the site document. */
async function writeHostedMirror(orgId: string, site: HostedDomainSite, input: {
  canonical: string; alias: string | null; canonicalKind?: 'apex' | 'www';
  canonicalStatus: HostingDomainStatus; aliasStatus: HostingDomainStatus | null;
  /** The hosted launch state: whether the site is launched, and on which primary hostname. */
  launch: { launched: boolean; primary_host: string | null; dns_target: string };
}): Promise<HostedDomainSite> {
  const launchedHere = input.launch.launched && input.launch.primary_host === input.canonical;
  const canonical = hostedState(input.canonicalStatus, launchedHere);
  const alias = input.aliasStatus ? hostedState(input.aliasStatus, launchedHere) : null;
  const update: Partial<Site> = {
    domain: input.canonical,
    domain_status: canonical.status,
    domain_added_at: site.domain_added_at ?? new Date().toISOString(),
    domain_dns_target: input.launch.dns_target || site.domain_dns_target,
    domain_failure_reason: canonical.reason ?? undefined,
    ...(canonical.status === 'verified' && !site.domain_verified_at ? { domain_verified_at: new Date().toISOString() } : {}),
    domain_alias: input.alias ?? undefined,
    domain_alias_status: alias?.status,
    domain_alias_failure_reason: alias?.reason ?? undefined,
    domain_canonical: input.alias ? input.canonicalKind : undefined,
    hosting_config: { ...(site.hosting_config ?? {}), launched: input.launch.launched },
  };
  await getStore().updateDoc(paths.site(orgId, site.id), update as Record<string, unknown>);
  return { ...site, ...update } as HostedDomainSite;
}

async function hostedRequestDomain(orgId: string, site: HostedDomainSite, rawHostname: string, prefer: 'apex' | 'www', kind: string): Promise<DomainStateResponse> {
  const pick = pickCanonical(rawHostname, prefer);
  const existingPairMatches = site.domain === pick.canonical && (pick.alias ? site.domain_alias === pick.alias : !site.domain_alias);
  if (site.domain && !existingPairMatches) {
    throw new DomainServiceError(`This site already has a custom domain (${site.domain}${site.domain_alias ? ` + ${site.domain_alias}` : ''}). Remove it first before adding a different one.`, 409);
  }
  return hosted(async () => {
    const domains = siteHosting();
    const ref = await hostingSiteRef(orgId, site.id);
    const canonicalStatus = await domains.addCustomDomain(ref, pick.canonical);
    let aliasStatus: HostingDomainStatus | null = null;
    if (pick.alias) {
      try { aliasStatus = await domains.addCustomDomain(ref, pick.alias); }
      catch (error) {
        // Never leave half a pair: the missing variant would not answer.
        if (!existingPairMatches) await domains.removeCustomDomain(ref, pick.canonical).catch(() => undefined);
        throw error;
      }
    }
    const state = await domains.domains(ref);
    const fresh = await writeHostedMirror(orgId, site, { canonical: pick.canonical, alias: pick.alias,
      canonicalKind: pick.alias ? (kind === 'www' && prefer === 'www' ? 'www' : prefer) : undefined,
      canonicalStatus, aliasStatus, launch: state });
    return toResponse(fresh)!;
  });
}

async function hostedPollDomainStatus(orgId: string, site: HostedDomainSite): Promise<DomainStateResponse> {
  if (!site.domain) throw new DomainServiceError('No custom domain is attached to this site.', 404);
  return hosted(async () => {
    const domains = siteHosting();
    const ref = await hostingSiteRef(orgId, site.id);
    const canonicalStatus = await domains.refreshCustomDomain(ref, site.domain!);
    const aliasStatus = site.domain_alias ? await domains.refreshCustomDomain(ref, site.domain_alias) : null;
    const state = await domains.domains(ref);
    const fresh = await writeHostedMirror(orgId, site, { canonical: site.domain!, alias: site.domain_alias ?? null, canonicalKind: site.domain_canonical,
      canonicalStatus, aliasStatus, launch: state });
    return toResponse(fresh)!;
  });
}

/** Launch the site on its custom domain: the primary is indexable, every other hostname redirects to it. */
async function hostedActivateDomain(orgId: string, site: HostedDomainSite): Promise<DomainStateResponse> {
  if (site.domain_status !== 'verified') {
    throw new DomainServiceError(`Cannot activate a domain whose status is "${site.domain_status ?? 'unknown'}". Check the domain until it is verified first.`, 412);
  }
  if (site.domain_alias && site.domain_alias_status !== 'verified' && site.domain_alias_status !== 'live') {
    throw new DomainServiceError(`Cannot activate while the sister hostname ${site.domain_alias} is "${site.domain_alias_status ?? 'unknown'}". Point DNS at ${site.domain_dns_target} for both, then check again.`, 412);
  }
  return hosted(async () => {
    await siteHosting().setLaunch(await hostingSiteRef(orgId, site.id), { launched: true, primary_host: site.domain! });
    const update = { domain_status: 'live' as const, ...(site.domain_alias ? { domain_alias_status: 'live' as const } : {}),
      hosting_config: { ...(site.hosting_config ?? {}), launched: true } };
    await getStore().updateDoc(paths.site(orgId, site.id), update);
    return toResponse({ ...site, ...update })!;
  });
}

/**
 * Remove the custom hostnames (Cloudflare first). When the removed domain was
 * the launched primary, the site is unlaunched rather than letting the
 * platform address become the indexable copy.
 */
async function hostedRemoveDomain(orgId: string, site: HostedDomainSite): Promise<{ ok: true }> {
  return hosted(async () => {
    const domains = siteHosting();
    const ref = await hostingSiteRef(orgId, site.id);
    const before = await domains.domains(ref);
    for (const hostname of [site.domain_alias, site.domain].filter((value): value is string => !!value)) await domains.removeCustomDomain(ref, hostname);
    const wasPrimary = !!before.primary_host && [site.domain, site.domain_alias].includes(before.primary_host);
    if (wasPrimary && before.launched) await domains.setLaunch(ref, { launched: false, primary_host: null });
    await getStore().updateDoc(paths.site(orgId, site.id), {
      domain: undefined, domain_status: undefined, domain_added_at: undefined, domain_verified_at: undefined, domain_dns_target: undefined,
      domain_failure_reason: undefined, domain_alias: undefined, domain_alias_status: undefined, domain_alias_failure_reason: undefined, domain_canonical: undefined,
      ...(wasPrimary && before.launched ? { hosting_config: { ...(site.hosting_config ?? {}), launched: false } } : {}),
    });
    return { ok: true as const };
  });
}

/**
 * Launch or unlaunch a hosted site without a custom domain: launched, its
 * platform address is the indexable site. Internal; with a launched custom
 * domain, use activateDomain/removeDomain instead.
 */
export async function setHostedSiteLaunch(orgId: string, siteId: string, launched: boolean): Promise<{ launched: boolean; primary_host: string | null }> {
  const stored = await getStore().getDoc<Site>(paths.site(orgId, siteId));
  if (stored?.publishing_mode !== HOSTED_MODE) throw new DomainServiceError('This site is not a hosted site.', 409);
  const site: HostedDomainSite = { ...stored, id: siteId };
  return hosted(async () => {
    const state = await siteHosting().setLaunch(await hostingSiteRef(orgId, siteId), { launched });
    await getStore().updateDoc(paths.site(orgId, siteId), {
      hosting_config: { ...(site.hosting_config ?? {}), launched },
      ...(site.domain && state.primary_host === site.domain ? { domain_status: launched ? 'live' : 'verified', ...(site.domain_alias ? { domain_alias_status: launched ? 'live' : 'verified' } : {}) } : {}),
    });
    return { launched: state.launched, primary_host: state.primary_host };
  });
}
