import { beforeEach, describe, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { DeployJob, Page, Site, SiteVersion } from '@typeroll/shared';
import { buildMigrationLaunchReport } from '../../lib/migration-launch-report';

const ORG = 'orgone';
const SITE = 'mysite';
const TARGET = 'https://mysite.sites.example.test';

async function seedReadyEvidence(): Promise<Site & { id: string }> {
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  const site = {
    id: SITE,
    name: 'Migration target',
    hosting_adapter: 'cloudflare',
    hosting_config: { fallback_subdomain: 'mysite.sites.example.test' },
    created_at: '2026-09-06T08:00:00.000Z',
  } satisfies Site;
  await store.setDoc(paths.site(ORG, SITE), site);
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: site.created_at, robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await store.setDoc(paths.settings(ORG, SITE), { site_name: 'Migration target', trailing_slash: 'always' });
  await store.setDoc(paths.page(ORG, SITE, 'home'), {
    id: 'home', title: 'Home', slug: '', status: 'published', content_mode: 'html', html_content: '<p>Ready</p>',
  } satisfies Page);
  await store.setDoc(paths.migrationUrl(ORG, SITE, 'root'), {
    path: '/', full_url: 'https://old.example.test/', observed_paths: ['/'],
    sources: ['sitemap'], found_at: '2026-09-06T08:00:00.000Z',
  });
  await store.setDoc(paths.deploy(ORG, SITE, 'deploy-one'), {
    version_id: MAIN_VERSION_ID, environment: 'staging', status: 'succeeded',
    started_at: '2026-09-06T09:55:00.000Z', finished_at: '2026-09-06T10:00:00.000Z',
    deploy_url: TARGET,
  } satisfies Omit<DeployJob, 'id'>);
  await store.setDoc(paths.migrationVerification(ORG, SITE), {
    version_id: MAIN_VERSION_ID,
    checked_at: '2026-09-06T10:30:00.000Z',
    deployment_job_id: 'deploy-one',
    deployment_finished_at: '2026-09-06T10:00:00.000Z',
    complete: true,
    target_origin: TARGET,
    checked: 1,
    expected_checks: 1,
    inventory_total: 1,
    truncated: false,
    summary: { checked: 1, ok: 1, ok_redirect: 0, missing: 0, broken_redirect: 0, error: 0, excluded: 0 },
    results: [],
    redirects_verified: 0,
  });
  await store.setDoc(paths.migrationSeoAcceptance(ORG, SITE), {
    status: 'accepted',
    checked_at: '2026-09-06T10:45:00.000Z',
    recorded_at: '2026-09-06T10:46:00.000Z',
    dataset: 'Sitemap and source crawl',
    source_origin: 'https://old.example.test',
    target_origin: TARGET,
    checked_pages: 1,
    differences: { total: 2, intentional: 2, unresolved: 0 },
    deployment_job_id: 'deploy-one',
    deployment_finished_at: '2026-09-06T10:00:00.000Z',
  });
  return site;
}

describe('migration launch report', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('is ready only when every independent section is complete and current', async () => {
    const site = await seedReadyEvidence();
    const { getStore } = await import('../../lib/datastore');
    const report = await buildMigrationLaunchReport({
      store: getStore(), orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, site,
      now: () => new Date('2026-09-06T11:00:00.000Z'),
    });

    expect(report.launch_ready).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.inventory.summary).toMatchObject({ total: 1, migrated: 1, unhandled: 0 });
    expect(report.internal_links.broken_links).toBe(0);
    expect(report.deployed_url_parity.status).toBe('current');
    expect(report.deployed_url_parity.untested_variants).toBe(0);
    expect(report.seo_parity.status).toBe('current');
  });

  it('fails closed when a newer deploy makes HTTP and SEO evidence stale', async () => {
    const site = await seedReadyEvidence();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.deploy(ORG, SITE, 'deploy-two'), {
      version_id: MAIN_VERSION_ID, environment: 'staging', status: 'succeeded',
      started_at: '2026-09-06T11:55:00.000Z', finished_at: '2026-09-06T12:00:00.000Z',
      deploy_url: TARGET,
    } satisfies Omit<DeployJob, 'id'>);

    const report = await buildMigrationLaunchReport({
      store: getStore(), orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, site,
    });
    expect(report.launch_ready).toBe(false);
    expect(report.deployed_url_parity.status).toBe('stale');
    expect(report.seo_parity.status).toBe('stale');
    expect(report.issues.map((issue) => issue.id)).toEqual(
      expect.arrayContaining(['url_parity_stale', 'seo_parity_stale']),
    );
  });

  it('keeps intentional exclusions visible and requires a reason', async () => {
    const site = await seedReadyEvidence();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.migrationUrl(ORG, SITE, 'legacy'), {
      path: '/legacy', full_url: 'https://old.example.test/legacy', observed_paths: ['/legacy'],
      sources: ['crawl'], excluded: true, found_at: '2026-09-06T08:00:00.000Z',
    });
    const report = await buildMigrationLaunchReport({
      store: getStore(), orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, site,
    });
    expect(report.inventory.summary.excluded).toBe(1);
    expect(report.inventory.exclusions_without_reason).toBe(1);
    expect(report.issues.map((issue) => issue.id)).toContain('exclusions_without_reason');
  });
});
