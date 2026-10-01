// Render a single revision of a page as preview HTML — used by the History
// panel so the user can see what a snapshot would look like before deciding
// to restore it. Read-only: nothing is written.
//
// The rendering itself lives in lib/revision-preview so the public API's
// GET /api/v1/sites/{siteId}/pages/{pageId}/revisions/{revId}/preview
// returns exactly the same document.

import type { APIRoute } from 'astro';
import { requireSiteAccess } from '../../../../../../../../lib/access';
import { isolatedPreviewHeaders } from '../../../../../../../../lib/preview-headers';
import { renderPageRevisionPreview } from '../../../../../../../../lib/revision-preview';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;

  const { pageId, revId } = params;
  if (!pageId || !revId) return new Response('Bad params', { status: 400 });

  const rendered = await renderPageRevisionPreview({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    pageId,
    revId,
  });
  if (!rendered.ok) return new Response(rendered.error, { status: rendered.status });

  // Read-only surface — nothing reaches into this iframe's document, so it
  // gets the opaque-origin sandbox the editor routes can't have.
  return new Response(rendered.html, {
    headers: {
      ...isolatedPreviewHeaders(),
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
};
