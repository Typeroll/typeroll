import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { validMediaId } from './public-copies';
import { findReferences, replaceReferences } from '../../../../../scripts/fixtures/static-publication/references.mjs';

export function resolvedMedia(media: Media, all: Map<string, Media>): Media {
  const seen = new Set<string>();
  let item = media;
  while (item.replacement_media_id) {
    if (seen.has(item.id)) throw new ConnectionError('Media replacement contains a cycle.', 409, 'media_replacement_cycle');
    seen.add(item.id);
    const next = all.get(item.replacement_media_id);
    if (!next) throw new ConnectionError('A replacement media file is missing. Restore it or clear the replacement.', 409, 'media_replacement_missing');
    item = next;
  }
  return item;
}

/** Resolve library aliases in memory; saved Pages and their editorial alt text stay untouched. */
export function applyMediaReplacements<T>(content: T, media: Media[]): T {
  if (!media.some(item => item.replacement_media_id)) return content;
  const all = new Map(media.map(item => [item.id, item]));
  const replacements = new Map<string, string>();
  const aliases = (source: Media) => [source.cdn_url, source.published_url, ...source.source_aliases ?? [], ...(source.variants ?? []).map(item => item.cdn_url)].filter((url): url is string => !!url);
  const found = findReferences(JSON.stringify(content), media.filter(item => item.replacement_media_id).flatMap(aliases));
  for (const source of media) {
    if (!source.replacement_media_id || !aliases(source).some(url => found.has(url))) continue;
    const target = resolvedMedia(source, all);
    for (const url of aliases(source)) {
      if (url) replacements.set(url, target.cdn_url);
    }
  }
  return replacements.size ? replaceReferences(content, replacements) : content;
}

/** Preview reads only replacement records and their targets, not the full library payload. */
export async function applySiteMediaReplacements<T>(content: T, orgId: string, siteId: string): Promise<T> {
  const store = getStore();
  const records = await store.listDocs<Media>(paths.media(orgId, siteId), { filters: [{ field: 'replacement_media_id', op: '>', value: '' }] });
  if (!records.length) return content;
  const all = new Map(records.map(item => [item.id, item]));
  for (const source of records) {
    const seen = new Set<string>();
    let item: Media | undefined = source;
    while (item?.replacement_media_id && !seen.has(item.id)) {
      seen.add(item.id);
      const id: string = item.replacement_media_id;
      if (!all.has(id)) {
        const target = await store.getDoc<Media>(`${paths.media(orgId, siteId)}/${id}`);
        if (!target) break; // applyMediaReplacements reports it if actually referenced.
        all.set(id, target);
      }
      item = all.get(id);
    }
  }
  return applyMediaReplacements(content, [...all.values()]);
}

/** Site-wide library operation. No binary copy, Page save, publication or deletion. */
export async function replaceMedia(orgId: string, siteId: string, sourceId: string, targetId: string | null, dryRun = true) {
  if (!validMediaId(sourceId) || (targetId !== null && !validMediaId(targetId)))
    throw new ConnectionError('Use valid media IDs from this site.', 400, 'invalid_media_id');
  const store = getStore();
  const path = (id: string) => `${paths.media(orgId, siteId)}/${id}`;
  const source = await store.getDoc<Media>(path(sourceId));
  if (!source) throw new ConnectionError('Source media not found on this site.', 404, 'media_not_found');
  const next = { ...source, replacement_media_id: targetId };
  const all = new Map<string, Media>([[sourceId, next]]);
  const guards = [];
  let id = targetId;
  while (id && !all.has(id)) {
    const member = await store.getDoc<Media>(path(id));
    if (!member) throw new ConnectionError('Replacement media not found on this site.', 404, 'media_not_found');
    all.set(id, member);
    guards.push({ path: path(id), expected: member as unknown as Record<string, unknown>, data: {}, guardOnly: true });
    id = member.replacement_media_id ?? null;
  }
  const resolved = resolvedMedia(next, all);
  if (targetId && (!resolved.storage || resolved.storage.state !== 'ready' || !/^[a-f0-9]{64}$/.test(resolved.sha256 ?? '')))
    throw new ConnectionError('Upload and verify the replacement file first.', 409, 'media_replacement_not_ready');
  // Guard every member of the chain so concurrent A→B / B→A cannot create a cycle.
  if (!dryRun && source.replacement_media_id !== targetId) {
    const { id: _id, ...data } = next;
    if (!await store.compareAndReplaceDoc(path(sourceId), source as unknown as Record<string, unknown>, data, guards))
      throw new ConnectionError('Media changed. Review the replacement and retry.', 409, 'media_replacement_conflict');
  }
  return { dry_run: dryRun, media_id: sourceId, replacement_media_id: targetId, resolved_media_id: resolved.id,
    scope: 'site_media_library', applies_to: 'all_versions', pages_written: 0,
    publication_required: !dryRun, preserves_page_alt_text: true };
}
