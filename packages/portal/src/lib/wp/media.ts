// Move media from WordPress to Cloudflare R2.
//
// For each image we download the original (or the largest variant we can
// reach), upload it to R2 via the S3-compatible API, and remember the
// old-URL → new-CDN-URL mapping. The cleaner uses that map to rewrite
// <img src> and srcset.
//
// We DON'T re-upload media that already lives at the new CDN base URL — re-
// running migration on a partly-migrated site is idempotent.

import crypto from 'node:crypto';
import { paths } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { siteMediaPrefix } from '../media-keys';
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

export interface MediaTransferConfig {
  bucket: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

export function readMediaConfig(): MediaTransferConfig | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !publicBaseUrl) return null;
  return { accountId, bucket, accessKeyId, secretAccessKey, publicBaseUrl };
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
    private store: ReadWriteStore,
    private cfg: MediaTransferConfig | null
  ) {}

  /**
   * Just-in-time entry point: ensure a WP image URL is on the new CDN,
   * returning the new URL (or the original when R2 isn't configured).
   *
   * Called per-image-actually-used-on-a-page, instead of pre-fetching the
   * entire WP media library. Idempotent and cached.
   *
   * @param wpUrl    the source URL from <img src> or similar
   * @param altHint  optional alt text to record on the media doc (when the
   *                 image came from a builder that knew the alt)
   */
  async ensureUrl(wpUrl: string, altHint?: string): Promise<UploadedMedia> {
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

    // If R2 isn't configured, keep the original URL but still record the
    // media doc so the customer's library shows what's referenced.
    if (!this.cfg) {
      return this.recordMedia({
        oldUrl: wpUrl,
        cdnUrl: wpUrl,
        altText: altHint ?? '',
        contentType,
        filename: cleanFilename,
      });
    }

    const key = `${await siteMediaPrefix(this.orgId, this.siteId, this.store)}/${hashed(wpUrl)}-${cleanFilename}`;
    const cdnUrl = `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;

    // Skip the upload if the object already exists in R2 (idempotent re-runs).
    const exists = await this.r2Head(key);
    if (!exists) {
      const dl = await fetch(wpUrl);
      if (!dl.ok) {
        // Don't fail the whole migration for one image — keep the old URL.
        return this.recordMedia({
          oldUrl: wpUrl,
          cdnUrl: wpUrl,
          altText: altHint ?? '',
          contentType,
          filename: cleanFilename,
        });
      }
      const body = Buffer.from(await dl.arrayBuffer());
      const detectedType = dl.headers.get('content-type') ?? contentType;
      await this.r2Put(key, body, detectedType);
    }

    return this.recordMedia({
      oldUrl: wpUrl,
      cdnUrl,
      altText: altHint ?? '',
      contentType,
      filename: cleanFilename,
    });
  }

  /** Transfer one media item. When R2 isn't configured we record the original URL so the migration still completes (useful for local testing). */
  async transfer(item: WPMedia): Promise<UploadedMedia> {
    const cleanFilename = sanitizeFilename(filenameFromUrl(item.source_url));
    const altText = item.alt_text ?? '';
    const width = item.media_details?.width;
    const height = item.media_details?.height;

    if (!this.cfg) {
      // No R2 — keep the original URL so the migrated site still renders
      // (with hot-linked WP images). The portal warns about this.
      return await this.recordMedia({
        oldUrl: item.source_url,
        cdnUrl: item.source_url,
        altText,
        width,
        height,
        contentType: item.mime_type ?? 'application/octet-stream',
        filename: cleanFilename,
      });
    }

    const key = `${await siteMediaPrefix(this.orgId, this.siteId, this.store)}/${hashed(item.source_url)}-${cleanFilename}`;
    const cdnUrl = `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;

    // Skip if already uploaded (idempotent re-runs).
    const head = await this.r2Head(key);
    if (!head) {
      const dl = await fetch(item.source_url);
      if (!dl.ok) throw new Error(`Download failed: ${dl.status} ${item.source_url}`);
      const body = Buffer.from(await dl.arrayBuffer());
      const contentType = dl.headers.get('content-type') ?? item.mime_type ?? 'application/octet-stream';
      await this.r2Put(key, body, contentType);
    }

    return await this.recordMedia({
      oldUrl: item.source_url,
      cdnUrl,
      altText,
      width,
      height,
      contentType: item.mime_type ?? 'application/octet-stream',
      filename: cleanFilename,
    });
  }

  private async recordMedia(args: {
    oldUrl: string;
    cdnUrl: string;
    altText: string;
    width?: number;
    height?: number;
    contentType: string;
    filename: string;
  }): Promise<UploadedMedia> {
    // De-dupe: if a media doc with this source_url already exists, return it
    // instead of creating a duplicate. Migration re-runs are common and we
    // don't want the media library doubling on every re-run.
    const existing = await this.store.listDocs<{ id: string; source_url?: string; cdn_url: string; alt_text?: string; width?: number; height?: number; mime_type?: string }>(
      paths.media(this.orgId, this.siteId)
    );
    const match = existing.find((m) => m.source_url === args.oldUrl);
    if (match) {
      return {
        oldUrl: args.oldUrl,
        cdnUrl: match.cdn_url,
        altText: match.alt_text ?? args.altText,
        width: match.width,
        height: match.height,
        contentType: match.mime_type ?? args.contentType,
        mediaId: match.id,
      };
    }

    const mediaId = await this.store.addDoc(paths.media(this.orgId, this.siteId), {
      filename: args.filename,
      cdn_url: args.cdnUrl,
      alt_text: args.altText,
      width: args.width,
      height: args.height,
      mime_type: args.contentType,
      source_url: args.oldUrl,
      created_at: new Date().toISOString(),
    });
    return {
      oldUrl: args.oldUrl,
      cdnUrl: args.cdnUrl,
      altText: args.altText,
      width: args.width,
      height: args.height,
      contentType: args.contentType,
      mediaId,
    };
  }

  // Lightweight S3-compatible REST calls. We use AWS Signature V4 via the
  // @aws-sdk/client-s3 package — already in the portal for signed uploads.

  private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client> | null = null;
  private async client() {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const { S3Client } = await import('@aws-sdk/client-s3');
      return new S3Client({
        region: 'auto',
        endpoint: `https://${this.cfg!.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: this.cfg!.accessKeyId,
          secretAccessKey: this.cfg!.secretAccessKey,
        },
      });
    })();
    return this.clientPromise;
  }

  private async r2Put(key: string, body: Buffer, contentType: string) {
    const c = await this.client();
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await c.send(new PutObjectCommand({ Bucket: this.cfg!.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  private async r2Head(key: string): Promise<boolean> {
    try {
      const c = await this.client();
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      await c.send(new HeadObjectCommand({ Bucket: this.cfg!.bucket, Key: key }));
      return true;
    } catch {
      return false;
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

function hashed(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
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
