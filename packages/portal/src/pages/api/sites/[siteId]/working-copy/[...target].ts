// Working-copy operations for the editors:
//   GET    → read the copy (null when none)
//   PUT    → shallow-merge fields (autosave)
//   POST   → COMMIT: promote the copy through the canonical write path
//            (revision snapshot, SEO transform, redirect hygiene) + delete it
//   DELETE → discard
//
// Target address is the trailing path: `page/{id}`, `partial/{id}`,
// `item/{collection}/{itemId}`. The commit logic lives in
// lib/working-copy.ts and is shared with the v1 REST surface so human and
// agent saves can never drift.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { vstore } from '../../../../../lib/version-store';
import {
  commitWorkingCopy,
  discardWorkingCopy,
  filterWcFields,
  mergeWorkingCopy,
  parseWcTarget,
  readWorkingCopy,
  WorkingCopyError,
  type WcCtx,
  type WcTarget,
} from '../../../../../lib/working-copy';

async function targetExists(ctx: WcCtx, target: WcTarget): Promise<boolean> {
  if (target.kind === 'page') {
    return !!(await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.id));
  }
  if (target.kind === 'partial') {
    // Partials are create-on-write (the editor opens header/footer before
    // they exist), so a working copy may precede the canonical doc.
    return true;
  }
  return !!(await vstore.collectionItem(
    ctx.orgId, ctx.siteId, ctx.versionId, target.collection, target.id,
  ));
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  const target = parseWcTarget(params.target);
  if (!target) return json({ error: 'Bad working-copy target' }, 400);
  const ctx: WcCtx = { orgId: owner_org_id, siteId: site.id, versionId };
  const wc = await readWorkingCopy(ctx, target);
  return json({ working_copy: wc });
};

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const target = parseWcTarget(params.target);
  if (!target) return json({ error: 'Bad working-copy target' }, 400);
  const ctx: WcCtx = { orgId: owner_org_id, siteId: site.id, versionId };

  const body = (await request.json().catch(() => null)) as
    | { fields?: Record<string, unknown> }
    | null;
  if (!body?.fields || typeof body.fields !== 'object') {
    return json({ error: 'fields object required' }, 400);
  }
  if (!(await targetExists(ctx, target))) return json({ error: 'Target not found' }, 404);

  try {
    const filtered = await filterWcFields(ctx, target, body.fields);
    const wc = await mergeWorkingCopy(ctx, target, filtered, session.email ?? undefined);
    return json({ ok: true, updated_at: wc.updated_at });
  } catch (e) {
    if (e instanceof WorkingCopyError) return json({ error: e.message }, e.status);
    throw e;
  }
};

export const POST: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const target = parseWcTarget(params.target);
  if (!target) return json({ error: 'Bad working-copy target' }, 400);
  try {
    const result = await commitWorkingCopy(
      { orgId: owner_org_id, siteId: site.id, versionId },
      target,
      session.email ?? 'unknown',
    );
    return json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof WorkingCopyError) return json({ error: e.message }, e.status);
    throw e;
  }
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, versionId, owner_org_id } = guard.value;
  const target = parseWcTarget(params.target);
  if (!target) return json({ error: 'Bad working-copy target' }, 400);
  await discardWorkingCopy({ orgId: owner_org_id, siteId: site.id, versionId }, target);
  return json({ ok: true });
};
