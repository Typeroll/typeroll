import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../../lib/access';
import { vstore } from '../../../../../../lib/version-store';
import { listRevisions, getRevision, snapshotRevision } from '../../../../../../lib/revisions';
import type { Page } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { pageId } = params;
  if (!pageId) return json({ error: 'Missing pageId' }, 400);

  const revs = await listRevisions({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'page',
    resourceIds: [pageId],
  });
  return json({ revisions: revs });
};

/** Restore the given revision. Snapshots the current state first so the
 *  restore itself shows up in history and is undoable. */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { pageId } = params;
  if (!pageId) return json({ error: 'Missing pageId' }, 400);

  const { revId } = (await request.json()) as { revId?: string };
  if (!revId) return json({ error: 'revId required' }, 400);

  const rev = await getRevision({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'page',
    resourceIds: [pageId],
    revId,
  });
  if (!rev) return json({ error: 'Revision not found' }, 404);

  const current = await vstore.page(owner_org_id, site.id, versionId, pageId);
  if (current) {
    await snapshotRevision({
      orgId: owner_org_id,
      siteId: site.id,
      versionId,
      kind: 'page',
      resourceIds: [pageId],
      doc: current as unknown as Record<string, unknown>,
      createdBy: session.email ?? 'unknown',
      note: `Replaced by restore of ${revId}`,
    });
  }

  // Restored doc gets a fresh updated timestamp so its position in lists is
  // current. The body is the snapshot; status falls back to the current
  // page's status when the snapshot doesn't include one.
  const restored = {
    ...(rev.doc as Partial<Page>),
    date_updated: new Date().toISOString(),
  };
  await vstore.writePage(owner_org_id, site.id, versionId, pageId, restored);
  return json({ ok: true });
};
