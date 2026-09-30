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
