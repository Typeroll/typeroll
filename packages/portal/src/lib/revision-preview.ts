// Render one saved page revision as preview HTML, shared by the portal's
// History panel (session route) and the public API. Read-only: nothing is
// written.
//
// The snapshot is fed to the normal preview pipeline through `pageOverride`.
// The page's current fields fill anything the snapshot lacks, and the current
// theme, header and footer give it context, so the preview shows what the
// revision would look like if it were restored now.

import type { Page } from '@typeroll/shared';
import { renderPreview } from './render-preview';
import { getRevision } from './revisions';
import { vstore } from './version-store';

export type RevisionPreviewResult =
  | { ok: true; html: string; page: Page }
  | { ok: false; status: 404 | 500; error: string };

export async function renderPageRevisionPreview(args: {
  orgId: string;
  siteId: string;
  versionId: string;
  pageId: string;
  revId: string;
  annotate?: boolean;
}): Promise<RevisionPreviewResult> {
  const { orgId, siteId, versionId, pageId, revId } = args;
  const rev = await getRevision({ orgId, siteId, versionId, kind: 'page', resourceIds: [pageId], revId });
  if (!rev) return { ok: false, status: 404, error: 'Revision not found' };
  const current = await vstore.page(orgId, siteId, versionId, pageId);
  if (!current) return { ok: false, status: 404, error: 'Page not found' };
  const pageOverride: Page = { ...current, ...(rev.doc as Partial<Page>), id: pageId };
  const html = await renderPreview(orgId, siteId, pageId, versionId, {
    pageOverride,
    showBanner: false,
    annotate: args.annotate === true,
    // The revision renders as it actually behaved. The session route serves
    // it in an opaque-origin sandbox; the API returns it as data.
    allowScripts: true,
  });
  if (!html) return { ok: false, status: 500, error: 'Render failed' };
  return { ok: true, html, page: pageOverride };
}
