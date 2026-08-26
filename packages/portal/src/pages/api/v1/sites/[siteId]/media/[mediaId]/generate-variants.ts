// POST /api/v1/sites/{siteId}/media/{mediaId}/generate-variants
//
// Runs the sharp-based srcset pipeline for one media item: fetches the
// original from R2, generates webp + avif variants at 320 / 640 / 1024 /
// 1920 (skipping upscales), uploads them, and patches the media doc
// with the variants array.
//
// Synchronous — each call takes roughly 1-5s per image depending on
// source resolution. The agent loops list_media → generate_variants
// across the library on its own; the platform doesn't queue.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../lib/datastore';
import { generateImageVariants } from '../../../../../../../lib/image-variants';
import { paths } from '@typeroll/shared';
import type { Media } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');

  const store = getStore();
  const media = await store.getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  if (!media) return apiError('Not found', 404);

  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !publicBase) {
    return apiError('R2 is not configured on this server', 503);
  }

  let result;
  try {
    result = await generateImageVariants(media, {
      accountId, bucket, accessKeyId, secretAccessKey, publicBase,
    });
  } catch (e) {
    return apiError(
      `Variant generation failed: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }
  if (!result) {
    // Non-image mime type (PDF etc.) — return a 200 with skipped reason
    // rather than an error since the agent's "sweep all media" loop
    // shouldn't fail when it hits a PDF.
    return apiResponse(ctx, {
      ok: true,
      skipped: true,
      reason: `Media type ${media.mime_type ?? 'unknown'} is not processable`,
    }, 200);
  }

  // Persist variants + source dimensions on the media doc.
  await store.setDoc(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`, {
    ...media,
    width: result.source_width,
    height: result.source_height,
    variants: result.variants,
  });
  const fresh = await store.getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  return apiResponse(ctx, {
    media: fresh,
    summary: {
      generated: result.variants.length,
      total_bytes: result.total_variant_bytes,
      skipped: result.skipped,
    },
  }, 200, {});
};
