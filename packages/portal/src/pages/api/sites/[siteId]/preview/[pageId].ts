import type { APIRoute } from 'astro';
import { requireSiteAccess } from '../../../../../lib/access';
import { renderPreview } from '../../../../../lib/render-preview';
import { isolatedPreviewHeaders } from '../../../../../lib/preview-headers';

export const GET: APIRoute = async ({ cookies, params, locals, request }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  const { pageId } = params;
  if (!pageId) return new Response('Missing pageId', { status: 400 });

  // Renders SAVED content only — working copies are overlaid solely by the
  // editor iframe's embed mode on the browse route.
  // Editor iframe — same-origin by necessity (see the headers below), so it
  // never renders block JS. A lower-privileged colleague's code would
  // otherwise run with this viewer's portal session. See the browse route
  // for the full reasoning.
  const canvasRaw = new URL(request.url).searchParams.get('canvas');
  const canvasId = canvasRaw && /^[A-Za-z0-9_-]{16,128}$/.test(canvasRaw) ? canvasRaw : undefined;
  const html = await renderPreview(owner_org_id, site.id, pageId, versionId, {
    allowScripts: false,
    editorCanvasId: canvasId,
  });
  if (!html) return new Response('Page not found', { status: 404 });

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...isolatedPreviewHeaders(),
    },
  });
};
