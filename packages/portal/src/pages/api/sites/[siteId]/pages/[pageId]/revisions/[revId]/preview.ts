// Render a single revision of a page as preview HTML — used by the History
// panel so the user can see what a snapshot would look like before deciding
// to restore it. Read-only: nothing is written.
//
// We reuse the same render-preview pipeline as the live preview but feed it
// the snapshot doc via `pageOverride`. The page's *current* slug, theme,
// header, and footer are used for context (so the preview makes sense), but
// the body/SEO/etc. come from the snapshot.

import type { APIRoute } from 'astro';
import { requireSiteAccess } from '../../../../../../../../lib/access';
import { renderPreview } from '../../../../../../../../lib/render-preview';
import { isolatedPreviewHeaders } from '../../../../../../../../lib/preview-headers';
import { getRevision } from '../../../../../../../../lib/revisions';
import { vstore } from '../../../../../../../../lib/version-store';
import type { Page } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const { pageId, revId } = params;
  if (!pageId || !revId) return new Response('Bad params', { status: 400 });

  const rev = await getRevision({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'page',
    resourceIds: [pageId],
    revId,
  });
  if (!rev) return new Response('Revision not found', { status: 404 });

  // Use the snapshot's fields where present, otherwise fall back to the
  // current page (so the preview always has a slug, title, etc., even if
  // the revision only captured the body).
  const current = await vstore.page(owner_org_id, site.id, versionId, pageId);
  if (!current) return new Response('Page not found', { status: 404 });
  const snapshot = rev.doc as Partial<Page>;
  const pageOverride: Page = { ...current, ...snapshot, id: pageId };

  const html = await renderPreview(owner_org_id, site.id, pageId, versionId, {
    pageOverride,
    showBanner: false,
    // Sandboxed response (see headers below) — an opaque origin can't reach
    // the portal session, so the revision can render as it actually behaved.
    allowScripts: true,
  });
  if (!html) return new Response('Render failed', { status: 500 });

  // Read-only surface — nothing reaches into this iframe's document, so it
  // gets the opaque-origin sandbox the editor routes can't have.
  return new Response(html, {
    headers: {
      ...isolatedPreviewHeaders(),
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
};
