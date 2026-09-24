// POST /api/sites/{siteId}/pages/{pageId}/blocks/convert
//
// Session route for a person reviewing HTML→blocks.
//   {}                         preview only; nothing is written
//   { accept: <fingerprint> } write the previewed blocks after the
//                              fingerprint still matches this page
//
// The fingerprint covers the source HTML and the unconverted report, so
// a stale or unseen preview cannot be applied. API keys cannot call this
// route; the public convert endpoint never writes.

import { createHash } from 'node:crypto';
import type { APIRoute } from 'astro';
import { json, requirePermission, requireSiteAccess } from '../../../../../../../lib/access';
import { vstore } from '../../../../../../../lib/version-store';
import { snapshotRevision } from '../../../../../../../lib/revisions';
import { htmlToBlocks, type UnconvertedMarkup } from '../../../../../../../lib/html-to-blocks';
import type { Page } from '@typeroll/shared';

function previewFingerprint(html: string, unconverted: UnconvertedMarkup[]): string {
  return createHash('sha256').update(JSON.stringify({ html, unconverted })).digest('hex');
}

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const pageId = params.pageId;
  if (!pageId) return json({ error: 'Missing pageId' }, 400);

  const body = await request.json().catch(() => ({})) as { accept?: unknown };
  if (body.accept !== undefined && typeof body.accept !== 'string') {
    return json({ error: 'accept must be the preview fingerprint' }, 400);
  }

  const page = await vstore.page(owner_org_id, site.id, versionId, pageId);
  if (!page) return json({ error: 'Not found' }, 404);
  const html = page.html_content ?? '';
  if (!html) {
    return json({
      blocks: [],
      summary: [],
      notes: ['Page has no html_content to convert.'],
      unconverted: [],
      fingerprint: previewFingerprint('', []),
      applied: false,
    });
  }

  const result = htmlToBlocks(html);
  const fingerprint = previewFingerprint(html, result.unconverted);
  if (!body.accept) {
    return json({ ...result, fingerprint, applied: false });
  }
  if (body.accept !== fingerprint) {
    return json({ error: 'Preview is stale. Request a new preview and review what could not be converted.' }, 409);
  }

  await snapshotRevision({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'page',
    resourceIds: [pageId],
    doc: page as unknown as Record<string, unknown>,
    createdBy: session.userId ?? 'system',
    note: 'Accepted HTML-to-blocks preview',
  });
  const update: Partial<Page> = { content_mode: 'blocks', blocks: result.blocks };
  await vstore.writePage(owner_org_id, site.id, versionId, pageId, update);
  return json({ ...result, fingerprint, applied: true });
};
