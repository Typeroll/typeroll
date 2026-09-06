import { paths } from '@typeroll/shared';
import type { DeployJob, Site } from '@typeroll/shared';
import type { ReadWriteStore } from './datastore';
import { checkInternalLinks } from './internal-link-check';
import type { StoredSiteParityEvidence } from './wp/url-parity';
import { analyzeCoverage } from './wp/url-inventory';
import { publicUrlsFor } from './site-public-urls';

export interface MigrationSeoAcceptance {
  status: 'accepted' | 'rejected';
  checked_at: string;
  recorded_at: string;
  dataset: string;
  source_origin: string;
  target_origin: string;
  checked_pages: number;
  differences: {
    total: number;
    intentional: number;
    unresolved: number;
  };
  notes?: string;
  deployment_job_id?: string;
  deployment_finished_at?: string;
}

export interface MigrationLaunchReport {
  generated_at: string;
  version_id: string;
  launch_ready: boolean;
  issues: Array<{ id: string; detail: string }>;
  inventory: {
    summary: Awaited<ReturnType<typeof analyzeCoverage>>['summary'];
    exclusions_without_reason: number;
  };
  internal_links: Awaited<ReturnType<typeof checkInternalLinks>>;
  deployment: {
    status: 'current' | 'missing';
    job_id: string | null;
    finished_at: string | null;
    deploy_url: string | null;
  };
  deployed_url_parity: {
    status: 'current' | 'stale' | 'missing' | 'incomplete' | 'failed';
    evidence: StoredSiteParityEvidence | null;
    untested_variants: number | null;
  };
  seo_parity: {
    status: 'current' | 'stale' | 'missing' | 'rejected';
    evidence: MigrationSeoAcceptance | null;
  };
}

export async function buildMigrationLaunchReport(args: {
  store: ReadWriteStore;
  orgId: string;
  siteId: string;
  versionId: string;
  site: Site & { id: string };
  now?: () => Date;
}): Promise<MigrationLaunchReport> {
  const { store, orgId, siteId, versionId, site } = args;
  const [{ urls, summary }, internalLinks, deploys, urlEvidence, seoEvidence] = await Promise.all([
    analyzeCoverage(store, orgId, siteId),
    checkInternalLinks({ store, orgId, siteId, versionId, site }),
    store.listDocs<DeployJob>(paths.deploys(orgId, siteId)),
    store.getDoc<StoredSiteParityEvidence>(paths.migrationVerification(orgId, siteId, versionId)),
    store.getDoc<MigrationSeoAcceptance>(paths.migrationSeoAcceptance(orgId, siteId, versionId)),
  ]);
  const issues: Array<{ id: string; detail: string }> = [];
  const exclusionsWithoutReason = urls.filter(
    (entry) => entry.status === 'excluded' && !entry.notes?.trim(),
  ).length;
  if (summary.total === 0) issues.push({ id: 'inventory_empty', detail: 'The migration inventory is empty.' });
  if (summary.unhandled > 0) issues.push({ id: 'inventory_unhandled', detail: `${summary.unhandled} inventory URL(s) are unhandled.` });
  if (exclusionsWithoutReason > 0) {
    issues.push({ id: 'exclusions_without_reason', detail: `${exclusionsWithoutReason} excluded URL(s) have no recorded reason.` });
  }
  if (internalLinks.broken_links > 0) {
    issues.push({ id: 'broken_internal_links', detail: `${internalLinks.broken_links} internal link(s) are broken.` });
  }

  const latestDeploy = deploys
    .filter((job) => job.version_id === versionId && job.status === 'succeeded' && job.dry_run !== true)
    .sort((a, b) => (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at))[0];
  const deployFinishedAt = latestDeploy?.finished_at ?? null;
  if (!latestDeploy || !deployFinishedAt) {
    issues.push({ id: 'deployment_missing', detail: 'No completed hosted deploy exists for this version.' });
  }

  const currentOrigins = new Set(
    Object.values(publicUrlsFor(site)).filter((value): value is string => Boolean(value)).map(normalizeOrigin),
  );
  let urlStatus: MigrationLaunchReport['deployed_url_parity']['status'] = 'missing';
  if (!urlEvidence) {
    issues.push({ id: 'url_parity_missing', detail: 'No complete deployed URL parity run has been recorded.' });
  } else if (urlEvidence.complete !== true || urlEvidence.truncated
    || urlEvidence.checked < (urlEvidence.expected_checks ?? urlEvidence.inventory_total)) {
    urlStatus = 'incomplete';
    issues.push({ id: 'url_parity_incomplete', detail: 'The latest deployed URL parity run did not cover the full inventory.' });
  } else if (!deployFinishedAt || urlEvidence.deployment_job_id !== latestDeploy?.id
    || urlEvidence.checked_at < deployFinishedAt
    || !currentOrigins.has(normalizeOrigin(urlEvidence.target_origin))) {
    urlStatus = 'stale';
    issues.push({ id: 'url_parity_stale', detail: 'The URL parity evidence predates the latest deploy or targets an old origin.' });
  } else if (urlEvidence.summary.missing > 0 || urlEvidence.summary.broken_redirect > 0 || urlEvidence.summary.error > 0) {
    urlStatus = 'failed';
    issues.push({
      id: 'url_parity_failed',
      detail: `The deployed run has ${urlEvidence.summary.missing} missing, ${urlEvidence.summary.broken_redirect} broken redirect and ${urlEvidence.summary.error} inconclusive result(s).`,
    });
  } else {
    urlStatus = 'current';
  }

  let seoStatus: MigrationLaunchReport['seo_parity']['status'] = 'missing';
  if (!seoEvidence) {
    issues.push({ id: 'seo_parity_missing', detail: 'No reviewed SEO/content parity evidence has been recorded.' });
  } else if (seoEvidence.status === 'rejected' || seoEvidence.differences.unresolved > 0) {
    seoStatus = 'rejected';
    issues.push({ id: 'seo_parity_rejected', detail: `${seoEvidence.differences.unresolved} SEO/content difference(s) remain unresolved.` });
  } else if (!deployFinishedAt || seoEvidence.deployment_job_id !== latestDeploy?.id
    || seoEvidence.checked_at < deployFinishedAt
    || !currentOrigins.has(normalizeOrigin(seoEvidence.target_origin))) {
    seoStatus = 'stale';
    issues.push({ id: 'seo_parity_stale', detail: 'The SEO/content review predates the latest deploy or targets an old origin.' });
  } else {
    seoStatus = 'current';
  }

  return {
    generated_at: (args.now?.() ?? new Date()).toISOString(),
    version_id: versionId,
    launch_ready: issues.length === 0,
    issues,
    inventory: { summary, exclusions_without_reason: exclusionsWithoutReason },
    internal_links: internalLinks,
    deployment: {
      status: latestDeploy && deployFinishedAt ? 'current' : 'missing',
      job_id: latestDeploy?.id ?? null,
      finished_at: deployFinishedAt,
      deploy_url: latestDeploy?.deploy_url ?? null,
    },
    deployed_url_parity: {
      status: urlStatus,
      evidence: urlEvidence ?? null,
      untested_variants: urlEvidence
        ? Math.max(0, (urlEvidence.expected_checks ?? urlEvidence.inventory_total) - urlEvidence.checked)
        : null,
    },
    seo_parity: { status: seoStatus, evidence: seoEvidence ?? null },
  };
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return value.replace(/\/+$/, '').toLowerCase();
  }
}
