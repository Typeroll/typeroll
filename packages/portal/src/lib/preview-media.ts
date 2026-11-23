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

/** Resolve imported PDF paths before a preview navigates them as site pages.
 * Match stored aliases exactly; a same-named file on a foreign host is never
 * replaced. No publication or public copy is needed for a private preview.
 */
export function rewritePreviewFileLinks(html: string, media: import('@typeroll/shared').Media[], browseRoot = '', liveOrigin?: string): string {
  const exact = new Map<string, string>(), paths = new Map<string, string>();
  for (const item of media) {
    if (item.mime_type !== 'application/pdf') continue;
    const aliases = [item.cdn_url, item.file_publication?.url, item.public_path, ...item.source_aliases ?? []];
    for (const alias of aliases) {
      if (typeof alias !== 'string') continue;
      exact.set(alias, item.cdn_url);
      try { paths.set(new URL(alias, 'https://preview.invalid').pathname, item.cdn_url); } catch { /* not a URL */ }
    }
  }
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return html.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, anchor => {
    const tag = /^<a\b[^>]*>/i.exec(anchor)![0];
    const attr = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!attr) return anchor;
    const href = (attr[1] ?? attr[2] ?? '').replaceAll('&amp;', '&');
    const resource = href.split('#')[0]!;
    let source = exact.get(href) ?? exact.get(resource), localPath = '';
    if (!source && href.startsWith('/') && !href.startsWith('//')) {
      localPath = href.split(/[?#]/)[0]!;
      if (browseRoot && localPath.startsWith(browseRoot + '/')) localPath = localPath.slice(browseRoot.length);
      source = paths.get(localPath);
    }
    let note = '';
    if (!source && /\.pdf(?:[?#]|$)/i.test(href)) {
      if (/^https?:\/\//i.test(href)) source = href.split('#')[0];
      else if (localPath) {
        source = liveOrigin ? new URL(localPath, liveOrigin).href : undefined;
        note = '<span data-preview-file-help="1" role="note"> This PDF could not be resolved in the preview library. It is only available on the published website.</span>';
      }
    }
    if (!source && !note) return anchor;
    const fragment = href.includes('#') ? '#' + href.split('#').slice(1).join('#') : '';
    const hrefAttr = source ? `href="${escape(source + fragment)}"` : 'aria-disabled="true"';
    const rewritten = tag.replace(attr[0], hrefAttr)
      .replace(/\s+(?:target|rel)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/>$/, ' data-preview-file-link="1" target="_blank" rel="noopener noreferrer">');
    return rewritten + anchor.slice(tag.length) + note;
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
