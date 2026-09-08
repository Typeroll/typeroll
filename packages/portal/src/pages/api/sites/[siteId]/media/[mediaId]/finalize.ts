// POST /api/sites/{siteId}/media/{mediaId}/finalize  (session-cookie auth)
//
// Session-cookie sibling of /api/v1/sites/{siteId}/media/{mediaId}/finalize.
// Called by the in-portal UI uploaders (MediaLibrary, MediaPicker, the
// chat composer) right after a successful PUT to R2. Idempotent.
//
// Auth differs from v1 (cookies instead of bearer) but the work is the
// same — same `finalizeMedia` lib call, same R2 env vars.

import type { APIRoute } from 'astro';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../../../../../../lib/datastore';
import { requireSiteAccess, requirePermission, json } from '../../../../../../lib/access';
import { finalizeMedia } from '../../../../../../lib/media-finalize';
import { requestMediaMigration } from '../../../../../../lib/publishing/media-migration';
import { finalizeStoredMedia } from '../../../../../../lib/publishing/media-storage';
import { connectionFailure } from '../../../../../../lib/publishing/http';

export const POST: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, owner_org_id } = guard.value;
  const mediaId = params.mediaId;
  if (!mediaId) return json({ error: 'Missing mediaId' }, 400);
  if ((await getStore().getDoc<Media>(`${paths.media(owner_org_id, site.id)}/${mediaId}`))?.storage) {
    try { return json({ ok: true, result: await finalizeStoredMedia(owner_org_id, site.id, mediaId) }); }
    catch (error) { return connectionFailure(error); }
  }

  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !publicBase) {
    return json({ error: 'R2 is not configured on this server' }, 503);
  }

  try {
    const result = await finalizeMedia(owner_org_id, site.id, mediaId, {
      accountId, bucket, accessKeyId, secretAccessKey, publicBase,
    });
    await requestMediaMigration(owner_org_id);
    return json({ ok: true, result });
  } catch (e) {
    return json(
      { error: `Finalize failed: ${e instanceof Error ? e.message : String(e)}` },
      500,
    );
  }
};
