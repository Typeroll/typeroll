import { paths, CORE_BLOCK_TYPES, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { projectStaticPublication } from '../../../../../scripts/lib/static-publication.mjs';
import { getSiteDomains, getOrganizationDomains, type DomainConfiguration, type OrganizationDomains } from './domain-config';
import { siteHostingGroup } from './hosting-groups';
import { resolvePublicationVersion } from './publication-version';
import { publicationRuntime } from './runtime-projection';
import { readSnapshot } from './publication-snapshot';
import { captureImpact, compareImpact } from './impact';
import { digest } from './providers.mjs';

export async function capturePublicationImpact(frozen: any, orgId: string, siteId: string, domains: DomainConfiguration, organization: OrganizationDomains, media: any[]) {
  return captureImpact({ ...frozen, impact_origins: { website: frozen.site_url, media: domains.desired.media_host ?? organization.media_host ?? null,
    media_path_prefix: domains.desired.media_path_prefix } }, orgId, siteId, media);
}

/** A read-only estimate against this version's last verified source, never a failed candidate. */
export async function previewPublicationImpact(orgId: string, siteId: string, versionId: string) {
  const store = getStore();
  const target = await store.getDoc<any>(`${paths.site(orgId, siteId)}/publishing_targets/${versionId}`);
  const reference = target?.last_publication;
  const unavailable = () => compareImpact(null, { protocol: 1, org_id: orgId, site_id: siteId, version_id: versionId, core_commit: '', entries: [] }, true);
  if (!reference?.snapshot_job_id) return unavailable();
  const job = await store.getDoc<any>(paths.deploy(orgId, siteId, reference.snapshot_job_id));
  if (job?.status !== 'succeeded' || job.version_id !== versionId || job.dry_run) return unavailable();
  const previous = await readSnapshot({ orgId, siteId, jobId: reference.snapshot_job_id }, reference);
  if (!previous.source_impact_snapshot || previous.version_id !== versionId) return unavailable();
  const [site, domains, organization, group, resolved, runtime, media] = await Promise.all([
    store.getDoc<Site>(paths.site(orgId, siteId)), getSiteDomains(orgId, siteId), getOrganizationDomains(orgId), siteHostingGroup(orgId, siteId),
    resolvePublicationVersion(orgId, siteId, versionId), publicationRuntime(orgId, siteId), store.listDocs<any>(paths.media(orgId, siteId)),
  ]);
  const prefix = digest(`${orgId}\0${siteId}`).slice(0, 16);
  const host = versionId === 'main' && domains.desired.website_host ||
    `${versionId === 'main' ? '' : `v-${digest(versionId).slice(0, 8)}-`}site-${prefix}.${group.sites_domain}`;
  const current = projectStaticPublication({ ...resolved, site: { ...site, domain: host }, media: [], forms: runtime.forms, extensions: runtime.extensions.installations, publicRuntime: runtime }, {
    siteUrl: `https://${host}`, coreCommit: process.env.TYPEROLL_SOURCE_SHA ?? '', publishedAt: new Date().toISOString(),
    noindex: versionId !== 'main' || !domains.desired.website_host, coreBlockTypes: CORE_BLOCK_TYPES,
  });
  return { ...compareImpact(previous.source_impact_snapshot, await capturePublicationImpact(current, orgId, siteId, domains, organization, media), true), baseline_publication_id: reference.publication_id, compared_at: new Date().toISOString() };
}
