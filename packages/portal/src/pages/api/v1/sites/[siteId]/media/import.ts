import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths, type Media } from '@typeroll/shared';
import { requireImportStorage, importStorageStatus } from '../../../../../../lib/media/import-policy';
import { connectionFailure, publishingJsonBody } from '../../../../../../lib/publishing/http';
import { WPMediaTransfer } from '../../../../../../lib/wp/media';
import { publicSource } from '../../../../../../lib/media/transfer-worker.mjs';
import { QUEUED_PREPARATION } from '../../../../../../lib/media/preparation';
import { MediaImportPendingError, type ImportingMedia } from '../../../../../../lib/media/import-retry';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  return apiResponse(guard.value, await importStorageStatus(guard.value.orgId));
};

/** Submit a URL, never a binary file. The customer's Worker performs the copy. */
export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission === 'read') return apiError('Importing media requires write permission.', 403);
  try {
    await requireImportStorage(ctx.orgId);
    const body = await publishingJsonBody(request);
    if (typeof body.source_url !== 'string' || body.source_url.length > 4096) return apiError('source_url must be a public website URL.');
    try { publicSource(body.source_url); } catch { return apiError('source_url must be a public website URL.'); }
    for (const key of ['filename', 'content_type', 'alt_text']) {
      if (body[key] !== undefined && (typeof body[key] !== 'string' || (body[key] as string).length > (key === 'alt_text' ? 2000 : 255))) return apiError(`${key} must be a valid string.`);
    }
    let result;
    try {
      result = await new WPMediaTransfer(ctx.orgId, ctx.siteId, getStore()).importUrl(body.source_url, {
        filename: body.filename as string | undefined, contentType: body.content_type as string | undefined, altText: body.alt_text as string | undefined,
      });
    } catch (error) {
      if (!(error instanceof MediaImportPendingError)) throw error;
      // The record exists and the Site's media migration retries the copy.
      // Answer with its id, so the caller polls it instead of importing again.
      const media = await getStore().getDoc<ImportingMedia>(`${paths.media(ctx.orgId, ctx.siteId)}/${error.mediaId}`);
      return apiResponse(ctx, { media_id: error.mediaId, cdn_url: media?.cdn_url ?? null, filename: media?.filename ?? null,
        content_type: media?.mime_type ?? null, size_bytes: null, finalize: null, finalize_error: null,
        import: { state: 'pending', error_code: error.code ?? 'media_transfer_unavailable',
          message: `The media record exists, but the file has not been copied yet: ${error.message} It is retried automatically; poll GET media/${error.mediaId} until import.state is complete instead of importing it again.`,
          retry: { automatic: true, next_attempt_at: error.retryAt === null ? null : new Date(error.retryAt).toISOString(), failed_attempts: media?.import_failures ?? 1 },
          ...(error.details ? { details: error.details } : {}) } }, 202);
    }
    const media = await getStore().getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${result.mediaId}`);
    return apiResponse(ctx, { media_id: result.mediaId, cdn_url: result.cdnUrl, filename: media?.filename,
      content_type: result.contentType, size_bytes: media?.size_bytes,
      finalize: { sha256: media?.sha256, variants_pending: true, ...(media?.preparation_pending ? { preparation: QUEUED_PREPARATION } : {}) }, finalize_error: null,
      import: { state: 'complete', error_code: null, message: null, retry: null } });
  } catch (error) { return connectionFailure(error); }
};
