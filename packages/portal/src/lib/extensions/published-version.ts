import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';

interface FrozenExtensions { extensions?: { installations?: Array<{ installation_id?: unknown; version?: unknown }> } }

/** The app version each installation was frozen with. Live pages call exactly these versions until the next publication activates. */
export function publicationExtensionVersions(frozen: FrozenExtensions): Record<string, string> {
  return Object.fromEntries((frozen.extensions?.installations ?? [])
    .filter(item => typeof item.installation_id === 'string' && typeof item.version === 'string')
    .map(item => [item.installation_id as string, item.version as string]));
}

/**
 * The version of an installation that the live publication of a site version uses: one
 * target read, never a snapshot. Null when nothing is published, the installation is not
 * in it, or the publication predates recorded versions.
 */
export async function publishedExtensionVersion(orgId: string, siteId: string, installationId: string, versionId = 'main'): Promise<string | null> {
  const target = await getStore().getDoc<{ last_publication?: { extension_versions?: Record<string, unknown> } | null }>(`${paths.site(orgId, siteId)}/publishing_targets/${versionId}`);
  const versions = target?.last_publication?.extension_versions;
  const version = versions && Object.hasOwn(versions, installationId) ? versions[installationId] : null;
  return typeof version === 'string' ? version : null;
}
