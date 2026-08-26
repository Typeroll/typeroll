// POST /api/v1/sites/{siteId}/media/{mediaId}/finalize
//
// Applies the post-upload finishes on a single media item:
//   1. CopyObject in place to set Cache-Control: public, max-age=31536000, immutable
//      on the R2 original (so cdn.typeroll.com caches like the variants do).
//   2. Generates the AVIF/WebP responsive variants if not already present
//      (same pipeline as /generate-variants — this endpoint subsumes that
//      one for new uploads; keep generate-variants for surgical reruns).
//
// Idempotent — calling twice is a no-op the second time. Designed so the
// upload client can call this immediately after PUT succeeds without
// worrying about races or duplicate variant uploads.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { finalizeMedia, MediaIntegrityError } from '../../../../../../../lib/media-finalize';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');

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
    return apiResponse(ctx, { ok: true, result }, 200);
  } catch (e) {
    // Corruption is the CALLER's signal to re-upload — 422, not a server error.
    if (e instanceof MediaIntegrityError) return apiError(e.message, 422);
    return apiError(
      `Finalize failed: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }
};
