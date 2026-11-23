// Finalize a direct upload before referencing it. Connected storage verifies
// and freezes the private original (sanitizing SVG when needed) and queues
// private image preparation on the organization build engine. No synchronous
// image transcoding happens here; connected originals stay private. Legacy
// records use the compatibility cache/SVG path and request media migration.
// Repeating finalization is safe; expected_sha256 verifies the source bytes.

import type { APIRoute } from 'astro';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../../../../../../../lib/datastore';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { finalizeMedia, MediaIntegrityError } from '../../../../../../../lib/media-finalize';
import { requestMediaMigration } from '../../../../../../../lib/publishing/media-migration';
import { finalizeOrganizationMedia } from '../../../../../../../lib/media/svg-media';
import { connectionFailure } from '../../../../../../../lib/publishing/http';
import { ConnectionError } from '../../../../../../../lib/publishing/connections';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');
  if (ctx.permission === 'read') return apiError('Finalizing media requires write permission.', 403);
  if ((await getStore().getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`))?.storage) {
    const body = await request.json().catch(() => ({}));
    try { return apiResponse(ctx, { ok: true, result: await finalizeOrganizationMedia(ctx.orgId, ctx.siteId, mediaId, typeof body?.expected_sha256 === 'string' ? body.expected_sha256 : undefined) }); }
    catch (error) { return connectionFailure(error); }
  }

  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !publicBase) {
    return apiError('R2 is not configured on this server', 503);
  }

  const body = (await request.json().catch(() => ({}))) as { expected_sha256?: string };

  try {
    const result = await finalizeMedia(
      ctx.orgId, ctx.siteId, mediaId,
      { accountId, bucket, accessKeyId, secretAccessKey, publicBase },
      { expectedSha256: typeof body.expected_sha256 === 'string' ? body.expected_sha256 : undefined },
    );
    await requestMediaMigration(ctx.orgId, ctx.siteId);
    return apiResponse(ctx, { ok: true, result }, 200);
  } catch (e) {
    // Corruption is the CALLER's signal to re-upload — 422, not a server error.
    if (e instanceof MediaIntegrityError) return apiError(e.message, 422);
    // An SVG that cannot be made inert is the caller's to fix — 400.
    if (e instanceof ConnectionError) return connectionFailure(e);
    return apiError(
      `Finalize failed: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }
};
