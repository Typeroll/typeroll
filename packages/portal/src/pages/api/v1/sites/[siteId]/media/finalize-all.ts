// POST /api/v1/sites/{siteId}/media/finalize-all
//
// Backfill endpoint: walks every media item on the site, applies the
// post-upload finalize (cache-headers + variant generation) to each. Use
// this on legacy sites whose media was uploaded before the finalize
// pipeline existed — autopilot.se is the canonical "fix this once" case.
//
// Synchronous and potentially slow (~1-5s per image when variants are
// missing; ~50 ms per image when only cache headers need applying).
// Caller may want to budget for the long tail on libraries >100 images.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { finalizeAllMedia } from '../../../../../../lib/media-finalize';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;

  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !publicBase) {
    return apiError('R2 is not configured on this server', 503);
  }

  try {
    const result = await finalizeAllMedia(ctx.orgId, ctx.siteId, {
      accountId, bucket, accessKeyId, secretAccessKey, publicBase,
    });
    return apiResponse(ctx, { ok: true, ...result }, 200);
  } catch (e) {
    return apiError(
      `Bulk finalize failed: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }
};
