// Republishes every live file of an organization's sites: each snippet and
// the live site fields. Run once when the organization's media storage
// becomes ready, so content saved before then (when it could only reach
// pages at publication) is live too. Failures are logged, never thrown.

import { MAIN_VERSION_ID, paths, type Site } from '@typeroll/shared';
import { getStore } from './datastore';
import { listSnippets, publishSnippetLive } from './snippet-write';
import { publishLiveSiteFields } from './live-site-fields';
import { vstore } from './version-store';

export async function republishSiteLiveFiles(orgId: string, siteId: string): Promise<{ published: number; failed: number }> {
  let published = 0, failed = 0;
  const count = (result: { published: boolean } | undefined) => { if (result) result.published ? published++ : failed++; };
  for (const snippet of await listSnippets({ orgId, siteId })) count(await publishSnippetLive({ orgId, siteId }, snippet));
  const fields = await vstore.siteFields(orgId, siteId, MAIN_VERSION_ID);
  const live = await publishLiveSiteFields({ orgId, siteId, versionId: MAIN_VERSION_ID }, fields, null);
  if (live && !('removed' in live)) count(live);
  return { published, failed };
}

export async function republishOrganizationLiveFiles(orgId: string): Promise<void> {
  for (const site of await getStore().listDocs<Site>(paths.sites(orgId))) {
    try { await republishSiteLiveFiles(orgId, site.id); }
    catch (error) { console.warn(`[live-files] site ${site.id}: live files not republished`, error instanceof Error ? error.message : error); }
  }
}
