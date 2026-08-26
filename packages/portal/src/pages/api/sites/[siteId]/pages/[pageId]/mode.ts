// POST /api/sites/{siteId}/pages/{pageId}/mode
//   body: { to: 'blocks' | 'html', convert?: boolean }
//
// Switch a page's content_mode. Always snapshots a revision before the
// flip so the previous state survives. When going HTML → blocks and
// `convert: true`, runs the heuristic converter so the page starts with
// a populated tree instead of empty.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess, requirePermission } from '../../../../../../lib/access';
import { vstore } from '../../../../../../lib/version-store';
import { snapshotRevision } from '../../../../../../lib/revisions';
import { htmlToBlocks } from '../../../../../../lib/html-to-blocks';
import type { Page } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const pageId = params.pageId;
  if (!pageId) return json({ error: 'Missing pageId' }, 400);

  const body = await request.json().catch(() => null) as {
    to?: 'blocks' | 'html';
    convert?: boolean;
  } | null;
  if (!body?.to || (body.to !== 'blocks' && body.to !== 'html')) {
    return json({ error: 'body.to must be "blocks" or "html"' }, 400);
  }

  const page = await vstore.page(owner_org_id, site.id, versionId, pageId);
  if (!page) return json({ error: 'Not found' }, 404);
  if (page.content_mode === body.to) {
    return json({ ok: true, content_mode: body.to, unchanged: true });
  }

  // Always snapshot before destructive change so users can restore.
  await snapshotRevision({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'page',
    resourceIds: [pageId],
    doc: page as unknown as Record<string, unknown>,
    createdBy: session.userId ?? 'system',
    note: `Pre-mode-switch: ${page.content_mode} → ${body.to}`,
  });

  const update: Partial<Page> = { content_mode: body.to };

  if (body.to === 'blocks') {
    // HTML → blocks. Optionally seed via heuristic converter.
    if (body.convert && page.html_content) {
      const result = htmlToBlocks(page.html_content);
      update.blocks = result.blocks;
    } else {
      update.blocks = page.blocks ?? [];
    }
    // Keep html_content as a backup until the user explicitly clears it;
    // the renderer ignores it when content_mode='blocks'.
  } else {
    // Blocks → HTML. We don't have a block-tree → HTML serializer
    // (would need to re-run the block renderer here). Wipe the body
    // and let the user start fresh in HTML mode. The pre-switch
    // revision still has the full block tree for restore.
    update.blocks = [];
    update.html_content = page.html_content ?? '';
  }

  await vstore.writePage(owner_org_id, site.id, versionId, pageId, update);
  return json({ ok: true, content_mode: body.to });
};
