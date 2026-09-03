import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { vstore } from '../../../../../lib/version-store';
import { snapshotRevision } from '../../../../../lib/revisions';
import { sanitizeBody } from '../../../../../lib/sanitize';
import type { Partial as PartialDoc } from '@typeroll/shared';

const ALLOWED: Array<keyof PartialDoc> = ['name', 'kind', 'content_mode', 'blocks', 'html_content', 'status'];

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { partialId } = params;
  if (!partialId) return json({ error: 'Missing partialId' }, 400);

  const body = (await request.json()) as Partial<PartialDoc>;
  const update: Partial<PartialDoc> = {};
  for (const k of ALLOWED) if (k in body) (update as Record<string, unknown>)[k] = body[k];
  // Sanitize at save so stored block bodies are always safe — the
  // <x-include> expander assumes this (the merged HTML it produces is then
  // re-sanitized at render, so removing that wrapper would still be safe).
  if (typeof update.html_content === 'string') {
    const settings = await vstore.settings(owner_org_id, site.id, versionId);
    update.html_content = sanitizeBody(update.html_content, settings?.iframe_allowed_hosts);
  }

  const existing = await vstore.partial(owner_org_id, site.id, versionId, partialId);

  // Default the kind from the id if creating a new block.
  if (!update.kind) {
    update.kind = partialId === 'header' || partialId === 'footer' ? partialId : 'free';
  }
  if (!update.content_mode) update.content_mode = 'html';
  if (!update.name && !existing) {
    update.name = body.name ?? partialId;
  }

  if (existing) {
    await snapshotRevision({
      orgId: owner_org_id,
      siteId: site.id,
      versionId,
      kind: 'partial',
      resourceIds: [partialId],
      doc: existing as unknown as Record<string, unknown>,
      createdBy: session.email ?? 'unknown',
    });
  }
  // Always stamp date_updated server-side so the editor's "pending deploy"
  // indicator has a fresh comparison point. Trusting the client's value
  // would let a stale page mark itself as "up to date".
  (update as Record<string, unknown>).date_updated = new Date().toISOString();
  await vstore.writePartial(owner_org_id, site.id, versionId, partialId, update);
  return json({ ok: true });
};

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { partialId } = params;
  if (!partialId) return json({ error: 'Missing partialId' }, 400);

  const doc = await vstore.partial(owner_org_id, site.id, versionId, partialId);
  if (!doc) return json({ error: 'Not found' }, 404);
  return json(doc);
};
