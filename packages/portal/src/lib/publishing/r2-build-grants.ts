import { randomUUID, createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Grants authorize exact objects and methods, never a bucket, listing, deletion, or parent key. */
export async function createBuildMediaGrants(client: S3Client, manifest: any, publicationId: string, ttlSeconds = 21600) {
  if (!/^[a-f0-9]{64}$/.test(publicationId) || !manifest.site_prefix || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) throw new Error('Invalid media grant scope');
  const read = (bucket: string, key: string) => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSeconds });
  const objects: Record<string, { get: string; put: string; headers: Record<string, string> }> = {};
  const originals: Record<string, string> = {};
  for (const entry of manifest.entries) {
    if (!entry.source_key.startsWith(`private/${manifest.site_prefix}/originals/`)) throw new Error('Original escaped publication scope');
    originals[entry.source_key] = await read(manifest.original_bucket, entry.source_key);
    const suffixes = [{ suffix: '', mime: entry.mime_type }];
    if (['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(entry.mime_type)) {
      for (const width of [320, 640, 1024, 1920]) for (const format of ['webp', 'avif']) suffixes.push({ suffix: `.v1.w${width}.${entry.sha256.slice(0, 16)}.${format}`, mime: `image/${format}` });
    }
    for (const base of [entry.public_key, ...(entry.aliases ?? []).map((alias: any) => alias.key)]) {
      if (!base.startsWith(`${manifest.site_prefix}/`) || base.split('/').some((part: string) => part === '..' || part === '.')) throw new Error('Public object escaped publication scope');
      for (const { suffix, mime } of suffixes) {
        const key = base + suffix;
        if (objects[key]) continue;
        const headers = { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable', 'if-none-match': '*' };
        objects[key] = { get: await read(manifest.public_bucket, key), headers,
          put: await getSignedUrl(client, new PutObjectCommand({ Bucket: manifest.public_bucket, Key: key, ContentType: mime, CacheControl: headers['cache-control'], IfNoneMatch: '*' }),
            { expiresIn: ttlSeconds, signableHeaders: new Set(Object.keys(headers)) }) };
      }
    }
  }
  const grants = { format: 1, publication_id: publicationId, account_id: manifest.account_id, original_bucket: manifest.original_bucket,
    public_bucket: manifest.public_bucket, expires_at: Date.now() + ttlSeconds * 1000, originals, objects };
  const bytes = Buffer.from(JSON.stringify(grants));
  const key = `build-grants/${manifest.site_prefix}/${randomUUID()}.json`;
  await client.send(new PutObjectCommand({ Bucket: manifest.original_bucket, Key: key, Body: bytes, ContentType: 'application/json', CacheControl: 'private, no-store' }));
  return { grant_url: await read(manifest.original_bucket, key), sha256: createHash('sha256').update(bytes).digest('hex'), publication_id: publicationId };
}
