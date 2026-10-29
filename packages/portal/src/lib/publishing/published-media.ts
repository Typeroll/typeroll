import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { mapPublicationParts } from './parallel';
import { MEDIA_VARIANT_SLOTS, mediaVariantSuffix } from '../../../../../scripts/fixtures/static-publication/media-recipe.mjs';

type ManifestEntry = { id: string; sha256: string; cdn_url: string; public_path: string; aliases: Array<{ url: string }> };

/**
 * Record a live publication on its media records.
 *
 * Every address the publication served joins `source_aliases`, so content that
 * still names it is rewritten to the file's current address next time. For the
 * main version, `published_url` and `published_path` name the address this
 * publication serves the file at; files it did not publish get null.
 */
export async function recordPublishedMedia(orgId: string, siteId: string, entries: ManifestEntry[], options: { main: boolean }): Promise<void> {
  const store = getStore();
  const published = new Set<string>();
  await mapPublicationParts<ManifestEntry, void>(entries, async entry => {
    published.add(entry.id);
    const mediaPath = `${paths.media(orgId, siteId)}/${entry.id}`;
    const aliases = [entry.cdn_url, ...entry.aliases.map(alias => alias.url)];
    for (const slot of MEDIA_VARIANT_SLOTS) for (const format of ['webp', 'avif']) aliases.push(entry.cdn_url + mediaVariantSuffix(slot, entry.sha256, format));
    const record = await store.getDoc<any>(mediaPath);
    if (!record) return;
    const missing = aliases.some(alias => !(record.source_aliases ?? []).includes(alias));
    const moved = options.main && (record.published_url !== entry.cdn_url || record.published_path !== entry.public_path);
    if (!missing && !moved) return;
    // Bytes replaced since this publication was prepared belong to the next one.
    await store.compareAndUpdateDoc<any>(mediaPath,
      current => current.sha256 === entry.sha256 && JSON.stringify(current.source_aliases) === JSON.stringify(record.source_aliases), {
        ...(missing ? { source_aliases: [...new Set([...(record.source_aliases ?? []), ...aliases])] } : {}),
        ...(moved ? { published_url: entry.cdn_url, published_path: entry.public_path } : {}),
      });
  });
  if (!options.main) return;
  const stale = (await store.listDocs<any>(paths.media(orgId, siteId)))
    .filter(record => !published.has(record.id) && (record.published_url != null || record.published_path != null));
  await mapPublicationParts<any, void>(stale, async record => {
    await store.compareAndUpdateDoc<any>(`${paths.media(orgId, siteId)}/${record.id}`,
      current => current.published_url === record.published_url, { published_url: null, published_path: null });
  });
}
