import type { Site } from '@typeroll/shared';
import { ConnectionError } from './connections';
import type { ProviderClient } from './providers.mjs';

/**
 * A site migrated earlier keeps publishing to its original Pages project.
 * Reuse only the recorded static project in its original account; never
 * recreate a missing project.
 */
export async function verifyManagedProject(client: ProviderClient, binding: NonNullable<Site['publishing_migration']>) {
  const project = await client(`/accounts/${binding.account_id}/pages/projects/${binding.project}`, { missing: true });
  if (!project || project.name !== binding.project || project.production_branch !== 'main' || project.source || project.canonical_deployment?.uses_functions === true) {
    throw new ConnectionError('The existing Pages project must be a static Direct Upload project with main as its production branch. Its settings have changed or it is unavailable.', 409, 'managed_project_mismatch');
  }
  if (!project.domains?.includes(binding.website_host)) throw new ConnectionError('The existing website host is no longer attached to its Pages project. Restore that attachment before migrating.', 409, 'managed_domain_mismatch');
  return project;
}
