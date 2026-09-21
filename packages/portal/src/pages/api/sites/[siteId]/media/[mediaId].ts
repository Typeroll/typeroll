import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import { publicMediaPath } from '../../../../../lib/publishing/domain-config';
import { connectionFailure } from '../../../../../lib/publishing/http';
import type { Media } from '@typeroll/shared';
import { deleteMediaObjects } from '../../../../../lib/media-deletion';

const EDITABLE: Array<keyof Media> = ['filename', 'alt_text', 'title', 'caption', 'width', 'height', 'public_path'];

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;
  const { mediaId } = params;
  if (!mediaId) return json({ error: 'Missing mediaId' }, 400);

  const doc = await getStore().getDoc<Media>(`${paths.media(owner_org_id, site.id)}/${mediaId}`);
  if (!doc) return json({ error: 'Not found' }, 404);
  return json(doc);
};

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id } = guard.value;
  const { mediaId } = params;
  if (!mediaId) return json({ error: 'Missing mediaId' }, 400);

  const body = (await request.json()) as Partial<Media>;
  const update: Record<string, unknown> = {};
  for (const k of EDITABLE) if (k in body) update[k] = body[k];

  const docPath = `${paths.media(owner_org_id, site.id)}/${mediaId}`;
  const existing = await getStore().getDoc<Media>(docPath);
  if (!existing) return json({ error: 'Not found' }, 404);

  if (update.public_path !== undefined) {
    try { update.public_path = update.public_path === null ? null : publicMediaPath(update.public_path); }
    catch (error) { return connectionFailure(error); }
  }
  await getStore().updateDoc(docPath, update);
  return json({ ok: true });
};

/**
 * Remove a media item: the objects behind it, then the document.
 *
 * Objects first, and the document is kept when any of them survive. The
 * previous order dropped the document regardless, trading a dangling link in
 * the UI against an orphan in storage — reasonable for one image, wrong as a
 * policy, because nothing ever came back to collect them and the document was
 * the only remaining index of those bytes.
 *
 * It also attempted R2 only when the record had no `storage`, so anything in
 * an organization's own bucket kept its bytes silently, and it never touched
 * variants. See lib/media-deletion.ts.
 */
export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, owner_org_id } = guard.value;
  const { mediaId } = params;
  if (!mediaId) return json({ error: 'Missing mediaId' }, 400);

  const store = getStore();
  const docPath = `${paths.media(owner_org_id, site.id)}/${mediaId}`;
  const existing = await store.getDoc<Media>(docPath);
  if (!existing) return json({ error: 'Not found' }, 404);

  const outcome = await deleteMediaObjects(owner_org_id, existing);
  if (outcome.failed.length > 0) {
    // Retryable, and the record stays so the objects remain findable.
    return json({
      error: 'The stored files for this item could not be removed. Nothing was deleted; try again.',
      failed: outcome.failed,
    }, 502);
  }
  await store.deleteDoc(docPath);
  return json({ ok: true, objects_deleted: outcome.deleted });
};
