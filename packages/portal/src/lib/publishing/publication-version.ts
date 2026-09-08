import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { SiteVersion } from '@typeroll/shared';
import { getStore } from '../datastore';
import { vstore } from '../version-store';

/** Resolve branch inheritance before freezing content; this internal result is not a public export. */
export async function resolvePublicationVersion(orgId: string, siteId: string, versionId: string) {
  const store = getStore();
  const seen = new Set<string>();
  let current = versionId;
  // Do not silently publish main after a selected branch or its base disappeared.
  while (current !== MAIN_VERSION_ID) {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(current) || seen.has(current) || seen.size >= 50) {
      throw new Error('Invalid publication version chain');
    }
    seen.add(current);
    const version = await store.getDoc<SiteVersion>(paths.version(orgId, siteId, current));
    if (!version || version.kind !== 'branch') throw new Error('Publication version no longer exists');
    current = version.base_version_id ?? MAIN_VERSION_ID;
  }
  const [settings, pages, partials, blockTypes, pageTemplates, redirects, definitions] = await Promise.all([
    vstore.settings(orgId, siteId, versionId),
    vstore.pages(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId),
    vstore.blockTypes(orgId, siteId, versionId),
    vstore.pageTemplates(orgId, siteId, versionId),
    vstore.redirects(orgId, siteId, versionId),
    vstore.collections(orgId, siteId, versionId),
  ]);
  const collections = await Promise.all(definitions.map(async definition => ({
    definition, items: await vstore.collectionItems(orgId, siteId, versionId, definition.name),
  })));
  return { versionId, settings, pages, partials, blockTypes, pageTemplates, redirects, collections };
}
