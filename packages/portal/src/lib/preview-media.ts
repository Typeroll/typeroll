/**
 * Rewrite this site's private media references in signed-preview HTML to the
 * token-authorized `/preview/{siteId}/media/{mediaId}` route.
 *
 * Matching follows `privateMediaReferences` (publication): any origin or none,
 * and any stored media id format. Legacy and imported media use non-UUID ids,
 * and content may carry an origin other than the current PORTAL_PUBLIC_URL, so
 * matching only UUIDs on the current origin left those images unauthorized
 * (401) inside the opaque preview frame.
 */
export function rewritePreviewMediaUrls(html: string, siteId: string, token: string): string {
  const site = encodeURIComponent(siteId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:https?:\\/\\/[a-zA-Z0-9.-]+(?::\\d+)?)?\\/api\\/sites\\/${site}\\/media\\/([a-zA-Z0-9_%.-]+)\\/content(?=[?#\\s"'<>),\\]\\\\&]|$)`,
    'g',
  );
  return html.replace(pattern, (match, rawId: string) => {
    let mediaId: string;
    try { mediaId = decodeURIComponent(rawId); } catch { return match; }
    if (!mediaId || mediaId.includes('/')) return match;
    return `/preview/${encodeURIComponent(siteId)}/media/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(token)}`;
  });
}

/**
 * The same responsive images as a publication, for a review preview: each
 * private image rewritten to the preview media route gets its prepared AVIF
 * and WebP variants (through the same route), its dimensions and the
 * publication's loading rules, by running the publication's image transform.
 * Images without prepared variants keep their original file.
 */
export async function withPreviewResponsiveImages(html: string, orgId: string, siteId: string, token: string): Promise<string> {
  const { getStore } = await import('./datastore');
  const { buildMediaLookup, paths, transformBodyForSeo } = await import('@typeroll/shared');
  const { preparedSourceWidth, preparedVariantSlots } = await import('./publishing/media-storage');
  const base = `/preview/${encodeURIComponent(siteId)}/media/`;
  const suffix = `?token=${encodeURIComponent(token)}`;
  const ids = new Set<string>();
  for (const match of html.matchAll(new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^?"'\\s<>/]+)\\?token=`, 'g'))) {
    try { ids.add(decodeURIComponent(match[1]!)); } catch { /* not ours */ }
  }
  if (!ids.size) return transformBodyForSeo(html, buildMediaLookup([]));
  const media = [];
  for (const id of [...ids].slice(0, 500)) {
    let item = await getStore().getDoc<import('@typeroll/shared').Media>(`${paths.media(orgId, siteId)}/${id}`);
    if (!item) continue;
    // Images stored without dimensions: the width from their preparation receipt, read once.
    if (!item.width && !item.prepared_width) { const width = await preparedSourceWidth(orgId, siteId, item); if (width) item = { ...item, prepared_width: width }; }
    const url = `${base}${encodeURIComponent(id)}${suffix}`;
    const slots = preparedVariantSlots(item) ?? [];
    media.push({ ...item, cdn_url: url, variants: slots.flatMap(({ slot, width }) => (['avif', 'webp'] as const)
      .map(format => ({ width, format, cdn_url: `${url}&variant=${slot}.${format}`, size_bytes: 0 }))) });
  }
  return transformBodyForSeo(html, buildMediaLookup(media));
}
