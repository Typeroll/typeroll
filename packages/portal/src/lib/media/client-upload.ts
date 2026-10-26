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
 * POST the finalize URL. When the server refuses the file (4xx, for example
 * `media_svg_invalid` or `media_integrity_failed`) the new record is deleted
 * so no broken item is left in the library, and the error is thrown. Server
 * or network failures keep the record (the work may have completed) and
 * also throw.
 */
export async function finalizeUpload(siteId: string, upload: UploadInfo, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (!upload.finalizeUrl) return null;
  let response: Response;
  try { response = await fetchImpl(upload.finalizeUrl, { method: 'POST' }); }
  catch {
    throw new MediaFinalizeError('The file was uploaded but could not be finished. Check your connection and upload it again.', null, 0, false);
  }
  const body = await response.json().catch(() => null) as { error?: string; code?: string; result?: unknown } | null;
  if (response.ok) return body?.result ?? body;
  const reason = body?.error ?? `Finalizing the upload failed (HTTP ${response.status}).`;
  const mediaId = uploadedMediaId(upload);
  if (response.status >= 400 && response.status < 500 && mediaId) {
    const removed = await fetchImpl(`/api/sites/${encodeURIComponent(siteId)}/media/${encodeURIComponent(mediaId)}`, { method: 'DELETE' })
      .then(result => result.ok).catch(() => false);
    throw new MediaFinalizeError(removed ? `${reason} The file was not added.` : `${reason} Delete the file from the Media library.`, body?.code ?? null, response.status, removed);
  }
  throw new MediaFinalizeError(`${reason} Upload the file again; if this keeps happening, delete it from the Media library.`, body?.code ?? null, response.status, false);
}
