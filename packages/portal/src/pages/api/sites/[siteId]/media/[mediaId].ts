import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import { publicMediaPath } from '../../../../../lib/publishing/domain-config';
import { connectionFailure } from '../../../../../lib/publishing/http';
import { assertMediaNameUpdate } from '../../../../../lib/media/file-types';
import type { Media } from '@typeroll/shared';
import { deleteMediaItem } from '../../../../../lib/media-deletion';

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
  // Demo content from a package: the flag can only be cleared (the editor keeps or replaced the file).
  if ('demo' in body) {
    if (body.demo !== false) return json({ error: 'demo can only be set to false (keep the file as the site\'s own)', code: 'media_demo_invalid' }, 400);
    update.demo = false;
  }

  const docPath = `${paths.media(owner_org_id, site.id)}/${mediaId}`;
  const existing = await getStore().getDoc<Media>(docPath);
  if (!existing) return json({ error: 'Not found' }, 404);

  if (update.public_path !== undefined) {
    try { update.public_path = update.public_path === null ? null : publicMediaPath(update.public_path); }
    catch (error) { return connectionFailure(error); }
  }
  try { assertMediaNameUpdate(existing, update); } catch (error) { return connectionFailure(error); }
  await getStore().updateDoc(docPath, update);
  return json({ ok: true });
};

/**
 * Remove a media item and everything it left behind: its private objects, its
 * prepared variants, every published copy in the organization's public bucket
 * and the Cloudflare cache of their URLs. See lib/media-deletion.ts →
 * deleteMediaItem.
 *
 * The record is replaced by a tombstone and deleted first, so it is gone
 * whatever storage says. What could not be removed is reported (HTTP 207) and
 * stays retryable from the tombstone. Objects another record still uses stay.
 */
export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, owner_org_id, session } = guard.value;
  const { mediaId } = params;
  if (!mediaId) return json({ error: 'Missing mediaId' }, 400);

  let outcome;
  try { outcome = await deleteMediaItem(owner_org_id, site.id, mediaId, { actor: session.userId ?? null }); }
  catch (error) { return connectionFailure(error); }
  if (!outcome) return json({ error: 'Not found' }, 404);
  return json(outcome.body, outcome.status);
};
