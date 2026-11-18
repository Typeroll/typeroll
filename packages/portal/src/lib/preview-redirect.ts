import { isolatedPreviewOrigin, type PreviewScope } from './preview-origin';
import { signPreviewTicket } from './preview-signing';

/** Mint only after the normal portal session/site/version guard succeeds. */
export function redirectToIsolatedPreview(request: Request, scope: PreviewScope, args: { slug: string; workingCopy?: boolean; canvas?: boolean; pageId?: string }): Response | null {
  const origin = isolatedPreviewOrigin(scope);
  if (!origin) return null;
  const { token } = signPreviewTicket({ orgId: scope.org_id, siteId: scope.site_id, versionId: scope.version_id,
    ttlSeconds: 3600, includeWorkingCopies: args.workingCopy,
    ...(args.canvas ? { canvas: { ...(args.pageId ? { page_id: args.pageId } : {}) } } : {}),
  });
  const target = new URL(`/preview/${encodeURIComponent(scope.site_id)}/${args.slug.replace(/^\/+/, '')}`, origin);
  // A slug must never change the selected origin, site, or authentication.
  if (target.origin !== origin || !target.pathname.startsWith(`/preview/${encodeURIComponent(scope.site_id)}/`)) throw new Error('Invalid preview path');
  const source = new URL(request.url);
  for (const key of ['embed', 'saved', 'interactive', 'canvas', 'consent', 'frame', 'bridge']) {
    const value = source.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  if (args.canvas) target.searchParams.set('embed', '1');
  target.searchParams.set('t', token);
  return new Response(null, { status: 302, headers: { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
