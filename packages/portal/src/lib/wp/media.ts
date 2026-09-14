// Imported originals always go directly to the organization’s verified storage.
import { copyWithTransferService } from '../media/remote-transfer';
import { importStorageStatus, requireImportStorage } from '../media/import-policy';
import { paths, type Media } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { createMediaUpload, finalizeTransferredMedia, storageClient } from '../publishing/media-storage';
import { durableTransfer, mediaTransfers, transferReservation } from '../media/transfer';
import type { WPMedia } from './client';

export interface UploadedMedia {
  oldUrl: string;
  cdnUrl: string;
  altText: string;
  width?: number;
  height?: number;
  contentType: string;
  mediaId: string;
}

export async function mediaTransferAvailability(orgId: string, _siteId: string) {
  const status = await importStorageStatus(orgId);
  return { configured: status.ready, private: true, destination: status.ready ? 'the organization’s private R2 storage' : null };
}

export class WPMediaTransfer {
  // In-process cache: avoid re-uploading the same WP image when it appears
  // on multiple pages. Survives only the lifetime of the workflow run.
  private urlCache = new Map<string, UploadedMedia>();
  // Cache in-flight transfers so two concurrent pages referencing the same
  // image don't both upload it.
  private inFlight = new Map<string, Promise<UploadedMedia>>();

  constructor(
    private orgId: string,
    private siteId: string,
    private store: ReadWriteStore
  ) {}

  /**
   * Just-in-time entry point: ensure a WP image URL is on the new CDN,
   * returning the new URL after verified storage has accepted the file.
   *
   * Called per-image-actually-used-on-a-page, instead of pre-fetching the
   * entire WP media library. Idempotent and cached.
   *
   * @param wpUrl    the source URL from <img src> or similar
   * @param altHint  optional alt text to record on the media doc (when the
   *                 image came from a builder that knew the alt)
   */
  async ensureUrl(wpUrl: string, altHint?: string): Promise<UploadedMedia> {
    await requireImportStorage(this.orgId);
    const cached = this.urlCache.get(wpUrl);
    if (cached) return cached;
    const pending = this.inFlight.get(wpUrl);
    if (pending) return pending;

    const promise = this.transferByUrl(wpUrl, altHint);
    this.inFlight.set(wpUrl, promise);
    try {
      const result = await promise;
      this.urlCache.set(wpUrl, result);
      return result;
    } finally {
      this.inFlight.delete(wpUrl);
    }
  }

  /**
   * Look up by URL: check existing media docs first (idempotent across
   * workflow runs), upload to R2 if not already there.
   */
  private async transferByUrl(wpUrl: string, altHint?: string): Promise<UploadedMedia> {
    const cleanFilename = sanitizeFilename(filenameFromUrl(wpUrl));
    const contentType = guessMimeType(cleanFilename);

    return this.transferPrivate(wpUrl, cleanFilename, contentType, altHint ?? '');
  }

  /** Import a source URL with optional metadata from the public API or an agent. */
  async importUrl(sourceUrl: string, options: { filename?: string; contentType?: string; altText?: string } = {}): Promise<UploadedMedia> {
    await requireImportStorage(this.orgId);
    const filename = sanitizeFilename(options.filename ?? filenameFromUrl(sourceUrl));
    return this.transferPrivate(sourceUrl, filename, options.contentType ?? guessMimeType(filename), options.altText ?? '');
  }

  async transfer(item: WPMedia): Promise<UploadedMedia> {
    await requireImportStorage(this.orgId);
    const filename = sanitizeFilename(filenameFromUrl(item.source_url));
    return this.transferPrivate(item.source_url, filename, item.mime_type ?? guessMimeType(filename), item.alt_text ?? '', item.media_details?.width, item.media_details?.height);
  }

  private async transferPrivate(oldUrl: string, filename: string, contentType: string, altText: string, width?: number, height?: number): Promise<UploadedMedia> {
    // Readiness must be checked even when reusing an import. A disconnected
    // customer account must never silently fall back to the old WordPress host.
    await requireImportStorage(this.orgId);
    return durableTransfer(this.store, paths.site(this.orgId, this.siteId), oldUrl, () =>
      mediaTransfers.run(new URL(oldUrl).host, transferReservation, () => this.copyPrivate(oldUrl, filename, contentType, altText, width, height)),
      async result => (await this.store.getDoc<Media>(`${paths.media(this.orgId, this.siteId)}/${result.mediaId}`))?.storage?.state === 'ready');
  }

  private async copyPrivate(oldUrl: string, filename: string, contentType: string, altText: string, width?: number, height?: number): Promise<UploadedMedia> {
    const candidates = await this.store.listDocs<Media & { source_url?: string; import_pending?: boolean }>(paths.media(this.orgId, this.siteId),
      { filters: [{ field: 'source_url', op: '==', value: oldUrl }], limit: 10 });
    const existing = candidates.find(item => item.storage?.state === 'ready');
    if (existing) return { oldUrl, cdnUrl: existing.cdn_url, altText: existing.alt_text ?? altText,
      width: existing.width, height: existing.height, contentType: existing.mime_type ?? contentType, mediaId: existing.id };
    {
      const pending = candidates.find(item => item.import_pending && item.storage?.state === 'uploading');
      const upload = pending ? { mediaId: pending.id, key: pending.storage!.key, cdnUrl: pending.cdn_url } : await createMediaUpload(this.orgId, this.siteId, { filename, contentType, altText, actor: 'wordpress-import' });
      const mediaPath = `${paths.media(this.orgId, this.siteId)}/${upload.mediaId}`;
      await this.store.updateDoc(mediaPath, { source_url: oldUrl, source_aliases: [oldUrl], import_pending: true });
      if (!pending) { const { requestMediaMigration } = await import('../publishing/media-migration'); await requestMediaMigration(this.orgId); }
      const media = await this.store.getDoc<Media>(mediaPath);
      const r2 = await storageClient(this.orgId, media!.storage!);
      try {
        const receipt = await copyWithTransferService({ orgId: this.orgId, sourceUrl: oldUrl, client: r2, bucket: media!.storage!.bucket, key: upload.key, contentType });
        await finalizeTransferredMedia(this.orgId, this.siteId, upload.mediaId, receipt);
        await this.store.updateDoc(mediaPath, { import_pending: false, import_error: null, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) });
        return { oldUrl, cdnUrl: upload.cdnUrl, altText, width, height, contentType, mediaId: upload.mediaId };
      } catch (error) {
        if ((await this.store.getDoc<Media>(mediaPath))?.storage?.state !== 'ready') await this.store.updateDoc(mediaPath, { import_pending: true, import_error: 'The source file has not been copied yet. Retry media migration from Publishing.' });
        throw error;
      } finally { r2.destroy(); }
    }
  }
}

function filenameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'file');
  } catch {
    return 'file';
  }
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png':  return 'image/png';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'avif': return 'image/avif';
    case 'svg':  return 'image/svg+xml';
    case 'pdf':  return 'application/pdf';
    case 'mp4':  return 'video/mp4';
    case 'webm': return 'video/webm';
    default:     return 'application/octet-stream';
  }
}

export function buildMediaMap(items: UploadedMedia[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const item of items) {
    m.set(item.oldUrl, item.cdnUrl);
    // Also map the URL without query string — WP often serves images both ways.
    try {
      const u = new URL(item.oldUrl);
      m.set(`${u.origin}${u.pathname}`, item.cdnUrl);
    } catch {
      /* ignore */
    }
  }
  return m;
}
