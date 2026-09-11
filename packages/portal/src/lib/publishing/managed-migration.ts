import { createHash } from 'node:crypto';
import { paths, type Site, type DeployJob } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError, getConnection } from './connections';
import { cloudflareClient } from './cloudflare-oauth';
import { siteHostingGroup } from './hosting-groups';
import { getSiteDomains, saveSiteDomains } from './domain-config';
import { selectedBuildProvider } from '../builds/selection';
import { readEngineConfiguration } from '../builds/state';
import { requestMediaMigration } from './media-migration';
import type { ProviderClient } from './providers.mjs';

function sourceRevision(site: Site, accountId: string, groupId: string) {
  return createHash('sha256').update(JSON.stringify([
    site.publishing_mode ?? 'managed', site.hosting_adapter, site.hosting_config?.pages_project,
    site.domain, site.hosting_group_id ?? 'default', accountId, groupId,
  ])).digest('hex');
}

/** Reuse only the recorded static project in its original account; never recreate a missing project. */
export async function verifyManagedProject(client: ProviderClient, binding: NonNullable<Site['publishing_migration']>) {
  const project = await client(`/accounts/${binding.account_id}/pages/projects/${binding.project}`, { missing: true });
  if (!project || project.name !== binding.project || project.production_branch !== 'main' || project.source || project.canonical_deployment?.uses_functions === true) {
    throw new ConnectionError('The existing Pages project must be a static Direct Upload project with main as its production branch. Its settings have changed or it is unavailable.', 409, 'managed_project_mismatch');
  }
  if (!project.domains?.includes(binding.website_host)) throw new ConnectionError('The existing website host is no longer attached to its Pages project. Restore that attachment before migrating.', 409, 'managed_domain_mismatch');
  return project;
}

export async function managedMigrationPlan(orgId: string, siteId: string) {
  const site = await getStore().getDoc<Site>(paths.site(orgId, siteId));
  if (!site) throw new ConnectionError('Site not found.', 404);
  if (site.publishing_mode === 'customer_git') return { state: 'migrated' as const, binding: site.publishing_migration ?? null };
  if (site.hosting_adapter !== 'cloudflare' || !site.hosting_config?.pages_project || !site.domain) {
    throw new ConnectionError('This migration requires an existing Cloudflare Pages site with a custom website host.', 409, 'managed_migration_unavailable');
  }
  const group = await siteHostingGroup(orgId, siteId);
  const connection = await getConnection(orgId, 'cloudflare', group.id);
  if (connection.status !== 'connected' || !connection.cloudflare || connection.cloudflare.account_id !== process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new ConnectionError('Connect this site’s existing Cloudflare account in Publishing before migrating. Moving a live site to a different account requires a separate domain migration.', 409, 'managed_account_mismatch');
  }
  const github = await getConnection(orgId, 'github');
  const engine = await readEngineConfiguration(orgId, await selectedBuildProvider(orgId));
  if (github.status !== 'connected' || !github.github || engine?.status !== 'ready') {
    throw new ConnectionError('Connect GitHub and finish the shared build engine setup in Publishing before migrating this site.', 409, 'shared_build_setup_required');
  }
  const binding = { account_id: connection.cloudflare.account_id, project: site.hosting_config.pages_project, website_host: site.domain,
    previous_deployment_id: '', hosting_group_id: group.id, migrated_at: '' };
  const project = await verifyManagedProject(await cloudflareClient(orgId, fetch, undefined, group.id), binding);
  if (!project.canonical_deployment?.id) throw new ConnectionError('The existing live deployment could not be identified. Publish or restore it before migration.', 409, 'managed_deployment_missing');
  return { state: 'ready' as const, revision: sourceRevision(site, connection.cloudflare.account_id, group.id),
    binding: { ...binding, previous_deployment_id: project.canonical_deployment.id as string },
    message: 'This site will use the connected GitHub account and shared build engine. Its Pages project, live website, DNS and existing media URLs stay in place. Publish afterward to deploy the new build.' };
}

/** Explicit per-site opt-in. Connecting organization storage never migrates another managed site. */
export async function migrateManagedSite(orgId: string, siteId: string, input: Record<string, unknown>) {
  const plan = await managedMigrationPlan(orgId, siteId);
  if (plan.state === 'migrated') { await requestMediaMigration(orgId); return plan; }
  if (!input || input.revision !== plan.revision) throw new ConnectionError('Site settings changed. Check the migration again before continuing.', 409, 'managed_migration_changed');
  const store = getStore();
  const jobs = await store.listDocs<DeployJob>(paths.deploys(orgId, siteId));
  if (jobs.some(job => !['succeeded', 'failed'].includes(job.status))) throw new ConnectionError('Wait for this site’s current publication to finish before migrating.', 409, 'publication_in_progress');
  const domains = await getSiteDomains(orgId, siteId);
  if (domains.desired.website_host && domains.desired.website_host !== plan.binding.website_host) {
    throw new ConnectionError('Keep the existing website host for this migration. Change domains after the first verified publication.', 409, 'managed_domain_mismatch');
  }
  if (!domains.desired.website_host) await saveSiteDomains(orgId, siteId, { revision: domains.revision, ...domains.desired, website_host: plan.binding.website_host, dns_mode: domains.dns_mode });
  const changed = await store.compareAndUpdateDoc<Site>(paths.site(orgId, siteId),
    site => sourceRevision(site, plan.binding.account_id, plan.binding.hosting_group_id) === plan.revision,
    { publishing_mode: 'customer_git', hosting_group_id: plan.binding.hosting_group_id, hosting_assignment_locked: true,
      publishing_migration: { ...plan.binding, migrated_at: new Date().toISOString() } });
  if (!changed) throw new ConnectionError('Site settings changed. Check the migration again before continuing.', 409, 'managed_migration_changed');
  await requestMediaMigration(orgId);
  return managedMigrationPlan(orgId, siteId);
}
