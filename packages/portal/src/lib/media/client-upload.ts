// Browser helper shared by the media uploaders (MediaLibrary, MediaPicker,
// chat attachments). No server imports: this module is bundled for the client.
//
// Finalize is not optional: organization storage keeps an upload private
// until it is verified, and SVG is published only after it is sanitized. A
// failed finalize must therefore reach the person who uploaded the file.

export class MediaFinalizeError extends Error {
  constructor(message: string, public code: string | null, public status: number, public removed: boolean) { super(message); }
}

interface UploadInfo { finalizeUrl?: string | null; mediaId?: string | null }

/** Media id from the upload response, or from its finalize URL. */
export function uploadedMediaId(upload: UploadInfo): string | null {
  if (upload.mediaId) return upload.mediaId;
  const match = upload.finalizeUrl?.match(/\/media\/([^/]+)\/finalize$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Refusals that cannot succeed for this upload: the file itself is unusable
 * (not a usable SVG, truncated or corrupted bytes, a type that cannot be
 * published, or a name that does not match). Only these remove the record.
 */
function terminalRefusal(status: number, code: string | undefined): boolean {
  if (status === 415 || status === 422) return true;
  return status === 400 && (code === 'media_svg_invalid' || code === 'media_extension_mismatch');
}
/** Transient: another finalize or a storage move changed the record, or a rate limit. */
const retryable = (status: number, code: string | undefined) => status === 429 || (status === 409 && code === 'media_revision_conflict');
const RETRY_DELAYS_MS = [500, 2000];

/**
 * POST the finalize URL. When the server refuses the file itself (see
 * terminalRefusal) the new record is deleted so no broken item is left in
 * the library, and the error is thrown. A concurrent change (409
 * media_revision_conflict) or a rate limit (429) is retried a few times.
 * Every other failure, including 401/403 and server or network errors,
 * keeps the record (the upload may be fine) and throws.
 */
export async function finalizeUpload(siteId: string, upload: UploadInfo, fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<unknown> {
  if (!upload.finalizeUrl) return null;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try { response = await fetchImpl(upload.finalizeUrl, { method: 'POST' }); }
    catch {
      throw new MediaFinalizeError('The file was uploaded but could not be finished. Check your connection and upload it again.', null, 0, false);
    }
    const body = await response.json().catch(() => null) as { error?: string; code?: string; result?: unknown } | null;
    if (response.ok) return body?.result ?? body;
    const code = body?.code;
    if (retryable(response.status, code) && attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
    const reason = body?.error ?? `Finalizing the upload failed (HTTP ${response.status}).`;
    const mediaId = uploadedMediaId(upload);
    if (terminalRefusal(response.status, code) && mediaId) {
      const removed = await fetchImpl(`/api/sites/${encodeURIComponent(siteId)}/media/${encodeURIComponent(mediaId)}`, { method: 'DELETE' })
        .then(result => result.ok).catch(() => false);
      throw new MediaFinalizeError(removed ? `${reason} The file was not added.` : `${reason} Delete the file from the Media library.`, code ?? null, response.status, removed);
    }
    const advice = response.status === 401 || response.status === 403
      ? 'Sign in again with access to this site, then finish or upload the file again.'
      : 'Upload the file again; if this keeps happening, delete it from the Media library.';
    throw new MediaFinalizeError(`${reason} ${advice}`, code ?? null, response.status, false);
  }
}
