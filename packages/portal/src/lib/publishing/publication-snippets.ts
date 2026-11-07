// Live snippets in a publication. Snippets are not versioned (one copy per
// site, written to its live files on save), so a publication reads them
// outside the version snapshot and freezes the copy it renders: a page shows
// that content without script, and the browser then fetches the newest file
// from the live base URL (null when the site has nowhere to serve live files;
// the blocks then show the published content only).

import { paths, type Snippet } from '@typeroll/shared';
import { getStore } from '../datastore';
import { liveBaseUrl } from './live-files';

/** The site's live snippets, by id. */
export async function siteSnippets(orgId: string, siteId: string): Promise<Snippet[]> {
  const snippets = await getStore().listDocs<Snippet>(paths.snippets(orgId, siteId));
  return snippets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** What a publication or preview renders of live content: the snippets now and where their live files are. */
export async function publicationLiveContent(orgId: string, siteId: string): Promise<{ snippets: Snippet[]; liveBaseUrl: string | null }> {
  const [snippets, base] = await Promise.all([siteSnippets(orgId, siteId), liveBaseUrl(orgId, siteId)]);
  return { snippets, liveBaseUrl: base };
}
