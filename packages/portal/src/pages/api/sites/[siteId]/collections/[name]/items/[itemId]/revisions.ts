import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../../../../lib/access';
import { vstore } from '../../../../../../../../lib/version-store';
import { listRevisions, getRevision, snapshotRevision } from '../../../../../../../../lib/revisions';
import type { CollectionItem } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { name, itemId } = params;
  if (!name || !itemId) return json({ error: 'Missing params' }, 400);

  const revs = await listRevisions({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'collection-item',
    resourceIds: [name, itemId],
  });
  return json({ revisions: revs });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { name, itemId } = params;
  if (!name || !itemId) return json({ error: 'Missing params' }, 400);

  const { revId } = (await request.json()) as { revId?: string };
  if (!revId) return json({ error: 'revId required' }, 400);

  const rev = await getRevision({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'collection-item',
    resourceIds: [name, itemId],
    revId,
  });
  if (!rev) return json({ error: 'Revision not found' }, 404);

  const current = await vstore.collectionItem(owner_org_id, site.id, versionId, name, itemId);
  if (current) {
    await snapshotRevision({
      orgId: owner_org_id,
      siteId: site.id,
      versionId,
      kind: 'collection-item',
      resourceIds: [name, itemId],
      doc: current as unknown as Record<string, unknown>,
      createdBy: session.email ?? 'unknown',
      note: `Replaced by restore of ${revId}`,
    });
  }

  const restored = { ...(rev.doc as Partial<CollectionItem>), updated_at: new Date().toISOString() };
  await vstore.writeCollectionItem(owner_org_id, site.id, versionId, name, itemId, restored);
  return json({ ok: true });
};
