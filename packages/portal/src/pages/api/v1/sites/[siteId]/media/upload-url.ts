// POST /api/v1/sites/{siteId}/media/upload-url
//
// Mints a signed PUT URL for direct-to-R2 upload (no bytes touch this
// server). The CDN URL of the eventual object is returned alongside, plus
// the new media doc id so the client can patch alt_text etc. afterwards.
//
// This route mirrors /api/sites/{siteId}/media/upload-url (the in-app one)
// — same R2 bucket, same key shape, same docs collection. The only
// difference is bearer-token auth instead of session cookies. The two
// handlers will be folded into a shared lib helper when we see a third
// caller; for now duplication is cheaper than the abstraction.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { siteMediaPrefix } from '../../../../../../lib/media-keys';
import { paths } from '@typeroll/shared';

const MAX_SIZE = 25 * 1024 * 1024;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;

  const body = (await request.json().catch(() => null)) as {
    filename?: string;
    content_type?: string;
    size?: number;
    alt_text?: string;
  } | null;
  if (!body) return apiError('Invalid JSON body');
  const { filename, content_type: contentType, size, alt_text } = body;

  if (!filename || !contentType) return apiError('filename and content_type are required');
  if (size && size > MAX_SIZE) return apiError(`File too large (max ${MAX_SIZE} bytes)`, 413);
  if (!contentType.startsWith('image/') && contentType !== 'application/pdf') {
    return apiError('Unsupported content type', 415);
  }

  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!accountId || !bucket || !publicBase) {
    return apiError(
      'R2 is not configured on this server (set R2_ACCOUNT_ID, R2_BUCKET, R2_PUBLIC_BASE_URL).',
      503,
    );
  }

  const key = `${await siteMediaPrefix(ctx.orgId, ctx.siteId)}/${Date.now()}-${sanitize(filename)}`;

  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    // See sibling /api/sites/.../media/upload-url.ts for the rationale —
    // aws-sdk v3.700+'s default checksum middleware produces presigned
    // URLs that R2 rejects (403). Disabling it makes the URL a plain
    // SigV4-signed PUT that the client uploads to without extra headers.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const uploadUrl = await getSignedUrl(
    r2,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
  const cdnUrl = `${publicBase.replace(/\/$/, '')}/${key}`;

  const mediaId = await getStore().addDoc(paths.media(ctx.orgId, ctx.siteId), {
    filename,
    cdn_url: cdnUrl,
    r2_key: key,
    mime_type: contentType,
    size_bytes: size,
    alt_text: alt_text ?? undefined,
    uploaded_by: `api-key:${ctx.keyPrefix}`,
    created_at: new Date().toISOString(),
  });

  // Finalize URL the caller MUST POST to after the PUT succeeds. R2 doesn't
  // apply Cache-Control on direct presigned uploads, so without finalize
  // the original sits with the CDN's default ~4h TTL and ships variants
  // skip entirely. finalize is idempotent — agents can call it on
  // retries without worry.
  const finalizePath = `/api/v1/sites/${ctx.siteId}/media/${mediaId}/finalize`;

  return apiResponse(
    ctx,
    {
      upload_url: uploadUrl,
      cdn_url: cdnUrl,
      key,
      media_id: mediaId,
      expires_in: 300,
      /** REQUIRED follow-up: POST here after the PUT completes. Sets
       *  immutable Cache-Control on the original AND generates AVIF/WebP
       *  responsive variants. Skipping this leaves the image uncached
       *  and unoptimised — Lighthouse will flag both. */
      finalize_url: finalizePath,
      next_step:
        'After uploading to upload_url, POST to finalize_url to apply cache headers + generate variants.',
    },
    200,
    { filename, contentType, size, alt_text },
  );
};
