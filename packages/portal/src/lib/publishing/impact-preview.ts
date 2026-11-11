import { paths, CORE_BLOCK_TYPES, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { projectStaticPublication } from '../../../../../scripts/lib/static-publication.mjs';
import { getSiteDomains, getOrganizationDomains, activePublicationDomains, type DomainConfiguration, type OrganizationDomains } from './domain-config';
import { siteHostingGroup } from './hosting-groups';
import { resolvePublicationVersion } from './publication-version';
import { publicationRuntime } from './runtime-projection';
import { readSnapshot } from './publication-snapshot';
import { captureImpact, compareImpact, legacyBaseline, withImpactOrigins, type BaselineUnavailableReason, type ImpactSnapshot } from './impact';
import { digest } from './providers.mjs';

/** The addresses a publication's fingerprint records. */
export const publicationImpactOrigins = (siteUrl: string, domains: DomainConfiguration, organization: OrganizationDomains) =>
  ({ website: siteUrl, media: domains.desired.media_host ?? organization.media_host ?? null, media_path_prefix: domains.desired.media_path_prefix });

export async function capturePublicationImpact(frozen: any, orgId: string, siteId: string, domains: DomainConfiguration, organization: OrganizationDomains, media: any[]) {
  return captureImpact({ ...frozen, impact_origins: publicationImpactOrigins(frozen.site_url, domains, organization) }, orgId, siteId, media);
}

/** A domain change's fingerprint: the content it republishes, at the addresses it is built for. */
export function domainChangeImpact(prior: ImpactSnapshot | null | undefined, siteUrl: string, domains: DomainConfiguration, organization: OrganizationDomains) {
  return prior ? withImpactOrigins(prior, publicationImpactOrigins(siteUrl, domains, organization)) : null;
}

/** Domain changes republished one after another before a normal publication; more is not a real history. */
const MAX_DOMAIN_HOPS = 5;

/**
 * The verified source fingerprint the live content of this version came from.
 *
 * A domain change (publication_intent domain_prepare) republishes the last
 * publication's content with new origins and becomes the version's last
 * publication. Before Core 0.3.28 it recorded no fingerprint of its own, so
 * every site whose last publication was a domain switch answered
 * verified_source_baseline_unavailable until it was published normally again.
 * Its content is the publication it was built from (`source_publication`), so
 * that publication's fingerprint is the baseline.
 */
export async function verifiedBaseline(orgId: string, siteId: string, versionId: string, reference: any):
  Promise<{ snapshot: ImpactSnapshot; publication_id: string; via_domain_change: boolean; publication: any } | { snapshot: null; reason: BaselineUnavailableReason }> {
  const store = getStore();
  let viaDomainChange = false;
  for (let hop = 0; reference?.snapshot_job_id; hop++) {
    const job = await store.getDoc<any>(paths.deploy(orgId, siteId, reference.snapshot_job_id));
    const domainChange = job?.publication_intent === 'domain_prepare' && job.version_id === versionId && !job.dry_run && job.status !== 'failed';
    if (!domainChange && (job?.status !== 'succeeded' || job.version_id !== versionId || job.dry_run)) return { snapshot: null, reason: 'publication_not_verified' };
    let frozen;
    try { frozen = await readSnapshot({ orgId, siteId, jobId: reference.snapshot_job_id }, reference); }
    catch (error) { if (hop === 0) throw error; return { snapshot: null, reason: 'baseline_snapshot_unreadable' }; }
    if (frozen.source_impact_snapshot && frozen.version_id === versionId) return { snapshot: frozen.source_impact_snapshot, publication_id: reference.publication_id, via_domain_change: viaDomainChange, publication: frozen };
    if (!domainChange || !job.source_publication?.snapshot_job_id || hop >= MAX_DOMAIN_HOPS) return { snapshot: null, reason: 'snapshot_without_source_baseline' };
    reference = job.source_publication; viaDomainChange = true;
  }
  return { snapshot: null, reason: 'not_published' };
}

/** A read-only estimate against this version's last verified source, never a failed candidate. */
export async function previewPublicationImpact(orgId: string, siteId: string, versionId: string) {
  const store = getStore();
  const target = await store.getDoc<any>(`${paths.site(orgId, siteId)}/publishing_targets/${versionId}`);
  const reference = target?.last_publication;
  const baseline = await verifiedBaseline(orgId, siteId, versionId, reference);
  if (!baseline.snapshot) return compareImpact(null, { protocol: 2, org_id: orgId, site_id: siteId, version_id: versionId, core_commit: '', entries: [] }, true, baseline.reason);
  const [site, savedDomains, organization, group, resolved, runtime, media] = await Promise.all([
    store.getDoc<Site>(paths.site(orgId, siteId)), getSiteDomains(orgId, siteId), getOrganizationDomains(orgId), siteHostingGroup(orgId, siteId),
    resolvePublicationVersion(orgId, siteId, versionId), publicationRuntime(orgId, siteId, versionId), store.listDocs<any>(paths.media(orgId, siteId)),
  ]);
  const domains = activePublicationDomains(savedDomains, site?.publishing_migration?.website_host);
  const prefix = digest(`${orgId}\0${siteId}`).slice(0, 16);
  const host = versionId === 'main' && domains.desired.website_host ||
    `${versionId === 'main' ? '' : `v-${digest(versionId).slice(0, 8)}-`}site-${prefix}.${group.sites_domain}`;
  const current = projectStaticPublication({ ...resolved, site: { ...site, domain: host }, media: [], forms: runtime.forms, extensions: runtime.extensions.installations, publicRuntime: runtime }, {
    siteUrl: `https://${host}`, coreCommit: process.env.TYPEROLL_SOURCE_SHA ?? '', publishedAt: new Date().toISOString(),
    noindex: versionId !== 'main' || host === `site-${prefix}.${group.sites_domain}`, coreBlockTypes: CORE_BLOCK_TYPES,
  });
  const impact = compareImpact(baseline.snapshot, await capturePublicationImpact(current, orgId, siteId, domains, organization, media), true, null, legacyBaseline(baseline.publication, current));
  // The addresses of a domain change already serve; the fingerprint predates them.
  if (baseline.via_domain_change) impact.reasons.push('baseline_predates_domain_change');
  return { ...impact, baseline_publication_id: baseline.publication_id, compared_at: new Date().toISOString() };
}
