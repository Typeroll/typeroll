import { createHash } from 'node:crypto';
import { paths, publicContentPage, contentPagePath, type Page, type ContentType } from '@typeroll/shared';
import { pageUrlFromDoc } from '../page-paths';
import { getStore } from '../datastore';
import { verifiedBaseline } from './impact-preview';

export function publishedPageProjection(publication: Record<string, any>, pageId: string) {
  const page = (publication.pages as Page[] | undefined)?.find(page => page.id === pageId);
  if (!page || !['published', 'unlisted'].includes(page.status)) return null;
  const type = (publication.contentTypes as ContentType[] | undefined)?.find(type => type.id === (page.content_type ?? 'page'));
  const fields = type ? publicContentPage(page, type).fields ?? {} : {};
  const path = type ? contentPagePath(page, type) : pageUrlFromDoc(page);
  if (!path || typeof publication.site_url !== 'string') return null;
  const base = new URL(publication.site_url);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) return null;
  const url = new URL(path, base);
  if (url.origin !== base.origin) return null;
  const safe = { id: page.id, title: page.title, content_type: page.content_type ?? 'page', status: page.status, fields, url: url.href };
  return { page: safe, revision: createHash('sha256').update(JSON.stringify(safe)).digest('hex') };
}

/** Reads only the last verified frozen source. Never overlays a working copy. */
export async function readPublishedPage(orgId: string, siteId: string, versionId: string, pageId: string) {
  const target = await getStore().getDoc<{ last_publication?: unknown }>(`${paths.site(orgId, siteId)}/publishing_targets/${versionId}`);
  const baseline = await verifiedBaseline(orgId, siteId, versionId, target?.last_publication);
  if (!baseline.snapshot) return null;
  const page = publishedPageProjection(baseline.publication, pageId);
  return page ? { ...page, publication_id: baseline.publication_id } : null;
}
