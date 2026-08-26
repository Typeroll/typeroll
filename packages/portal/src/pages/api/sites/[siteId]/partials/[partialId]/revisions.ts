import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../../lib/access';
import { vstore } from '../../../../../../lib/version-store';
import { listRevisions, getRevision, snapshotRevision } from '../../../../../../lib/revisions';
import type { Partial as PartialDoc } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { partialId } = params;
  if (!partialId) return json({ error: 'Missing partialId' }, 400);

  const revs = await listRevisions({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'partial',
    resourceIds: [partialId],
  });
  return json({ revisions: revs });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { partialId } = params;
  if (!partialId) return json({ error: 'Missing partialId' }, 400);

  const { revId } = (await request.json()) as { revId?: string };
  if (!revId) return json({ error: 'revId required' }, 400);

  const rev = await getRevision({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'partial',
    resourceIds: [partialId],
    revId,
  });
  if (!rev) return json({ error: 'Revision not found' }, 404);

  const current = await vstore.partial(owner_org_id, site.id, versionId, partialId);
  if (current) {
    await snapshotRevision({
      orgId: owner_org_id,
      siteId: site.id,
      versionId,
      kind: 'partial',
      resourceIds: [partialId],
      doc: current as unknown as Record<string, unknown>,
      createdBy: session.email ?? 'unknown',
      note: `Replaced by restore of ${revId}`,
    });
  }

  await vstore.writePartial(owner_org_id, site.id, versionId, partialId, rev.doc as Partial<PartialDoc>);
  return json({ ok: true });
};
