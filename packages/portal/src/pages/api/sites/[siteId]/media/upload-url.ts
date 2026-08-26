// Signed R2 upload URL.
//
// Returns a presigned PUT URL the client can use to upload an image directly
// to Cloudflare R2 — no bytes pass through this server. The eventual public
// URL on the CDN is also returned.
//
// The route is per-site so the siteId is verified against the caller's org
// (no more "user uploads to a sibling org's bucket prefix"). The R2 object
// key is derived from site.id, not from any user input.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { siteMediaPrefix } from '../../../../../lib/media-keys';
import { paths } from '@typeroll/shared';

const MAX_SIZE = 25 * 1024 * 1024;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id } = guard.value;

  const { filename, contentType, size } = (await request.json()) as {
    filename: string;
    contentType: string;
    size?: number;
  };

  if (!filename || !contentType) {
    return json({ error: 'filename and contentType are required' }, 400);
  }
  if (size && size > MAX_SIZE) {
    return json({ error: `File too large (max ${MAX_SIZE} bytes)` }, 413);
  }
  if (!contentType.startsWith('image/') && contentType !== 'application/pdf') {
    return json({ error: 'Unsupported content type' }, 415);
  }

  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!accountId || !bucket || !publicBase) {
    return json(
      { error: 'R2 is not configured on this server (set R2_ACCOUNT_ID, R2_BUCKET, R2_PUBLIC_BASE_URL).' },
      503
    );
  }

  // Namespace by the site's anonymous random media_id (see lib/media-keys.ts):
  // unique per site, keeps org/site names out of the public URL, and survives
  // a site moving between orgs. orgId only locates the site doc, not the key.
  const key = `${await siteMediaPrefix(owner_org_id, site.id)}/${Date.now()}-${sanitize(filename)}`;

  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    // R2 doesn't require checksums. aws-sdk v3.700+ defaults to
    // `WHEN_SUPPORTED` which adds an `x-amz-checksum-crc32` query param to
    // presigned URLs (and a matching header expectation on upload) — but
    // it does NOT add the checksum header to SignedHeaders. The result: a
    // naive PUT that includes `x-amz-checksum-crc32` as a header gets 403
    // for SigV4 mismatch, and a naive PUT that omits it gets 400 for
    // "checksum required but missing". Switching to `WHEN_REQUIRED`
    // disables the middleware entirely for R2, so the presigned URL is a
    // plain PUT with just host + content-type signed. The client uploads
    // with no checksum header and it works.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  const uploadUrl = await getSignedUrl(
    r2,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: 300 }
  );

  const cdnUrl = `${publicBase.replace(/\/$/, '')}/${key}`;

  // Pre-register the media doc so the library knows about it. The client can
  // patch dimensions later once the upload completes. r2_key is stored so a
  // later delete can also remove the underlying R2 object.
  const store = getStore();
  await store.addDoc(paths.media(owner_org_id, site.id), {
    filename,
    cdn_url: cdnUrl,
    r2_key: key,
    mime_type: contentType,
    size_bytes: size,
    uploaded_by: session.userId,
    created_at: new Date().toISOString(),
  });

  // Look up the freshly-created media id so the client knows where to call
  // finalize. The store auto-assigns the id, so we re-fetch the most
  // recent media doc by cdn_url. Cheap (one extra list call) and avoids
  // changing the store contract.
  const mediaList = await store.listDocs<{ id: string; cdn_url?: string }>(
    paths.media(owner_org_id, site.id),
  );
  const justAdded = mediaList.find((m) => m.cdn_url === cdnUrl);
  // Cookie-auth path — points at the cookie-auth finalize endpoint, not
  // the v1 one (which requires API key bearer auth and would 401 from a
  // browser session).
  const finalizeUrl = justAdded
    ? `/api/sites/${site.id}/media/${justAdded.id}/finalize`
    : null;

  return json({
    uploadUrl,
    cdnUrl,
    key,
    /** Call this after a successful PUT — applies immutable Cache-Control
     *  to the original and generates AVIF/WebP responsive variants. Without
     *  it the image ships uncached and unoptimised. */
    finalizeUrl,
  });
};
