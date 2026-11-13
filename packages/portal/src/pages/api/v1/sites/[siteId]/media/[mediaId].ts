// GET    /api/v1/sites/{siteId}/media/{mediaId}
// PATCH  /api/v1/sites/{siteId}/media/{mediaId}   alt_text, filename, public_path, demo (false only)
//        filename and public_path must end in an extension that matches the
//        media type (lib/media/file-types.ts).
// DELETE /api/v1/sites/{siteId}/media/{mediaId}
//
// DELETE removes the item and everything it left behind: its private
// objects, its prepared variants, every published copy in the organization's
// public bucket and the Cloudflare cache of their URLs (lib/media-deletion.ts
// → deleteMediaItem). 207 when something is left for a retry
// (POST media/published-copies with this media id); the record is deleted
// either way and a tombstone keeps what is left.
//
// DELETE is irreversible (originals and every public copy go), so an
// Extension installation credential is refused even with media:write; people
// and API keys with write permission may delete.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import { publicMediaPath } from '../../../../../../lib/publishing/domain-config';
import { connectionFailure } from '../../../../../../lib/publishing/http';
import { assertMediaNameUpdate } from '../../../../../../lib/media/file-types';
import type { Media } from '@typeroll/shared';
import { importStatus, type ImportingMedia } from '../../../../../../lib/media/import-retry';
import { deleteMediaItem } from '../../../../../../lib/media-deletion';

const WRITABLE: Array<keyof Media> = ['alt_text', 'filename', 'public_path'];

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');
  const doc = await getStore().getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  if (!doc) return apiError('Not found', 404);
  // An import from a URL reports whether its copy is done, still being retried, or set aside.
  return apiResponse(ctx, { media: doc, import: importStatus(doc as ImportingMedia) });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission === 'read') return apiError('Media changes require write permission.', 403);
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');
  const store = getStore();
  const existing = await store.getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  if (!existing) return apiError('Not found', 404);
  const body = (await request.json().catch(() => null)) as Partial<Media> | null;
  if (!body) return apiError('Invalid JSON body');
  const update: Record<string, unknown> = {};
  for (const k of WRITABLE) if (body[k] !== undefined) update[k] = body[k];
  // Demo content from a package: the flag can only be cleared.
  if (body.demo !== undefined) {
    if (body.demo !== false) return apiError('demo can only be set to false (keep the file as the site\'s own)', 400, ctx, { code: 'media_demo_invalid' });
    update.demo = false;
  }
  if (Object.keys(update).length === 0) return apiError('No writable fields in body');
  if (update.public_path !== undefined) {
    try { update.public_path = update.public_path === null ? null : publicMediaPath(update.public_path); }
    catch (error) { return connectionFailure(error); }
  }
  try { assertMediaNameUpdate(existing, update); } catch (error) { return connectionFailure(error); }
  await store.updateDoc(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`, update);
  const fresh = await store.getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  return apiResponse(ctx, { media: fresh }, 200, body);
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity) {
    return apiError('Extension installation credentials cannot delete media: deleting removes the original and every published copy and cannot be undone. Ask a person with write access to the site, or use an API key.', 403, ctx, { code: 'extension_media_delete_refused' });
  }
  if (ctx.permission === 'read') return apiError('Media changes require write permission.', 403);
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');
  let outcome;
  try { outcome = await deleteMediaItem(ctx.orgId, ctx.siteId, mediaId, { actor: ctx.personalUserId ?? ctx.keyPrefix ?? null }); }
  catch (error) { return connectionFailure(error); }
  if (!outcome) return apiError('Not found', 404, ctx);
  return apiResponse(ctx, outcome.body, outcome.status);
};
