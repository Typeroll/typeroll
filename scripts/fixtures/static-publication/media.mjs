import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cache = 'public, max-age=31536000, immutable';
async function boundedBytes(response, limit = 25 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of response) { size += chunk.length; if (size > limit) throw new Error('Media response is too large'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

/** Runs on the customer's build machine. No original or generated image is committed to Git. */
export async function prepareMedia(publication, root) {
  const retainedFiles = [];
  for (const previous of publication.retained_media_manifests ?? []) {
    retainedFiles.push(...await prepareMedia({ ...publication, media_manifest: previous, media: previous.entries.map(entry => ({ ...entry })), retained_media_manifests: [] }, root));
  }
  const manifest = publication.media_manifest;
  if (!manifest?.entries?.length) return retainedFiles;
  let credentials;
  try { credentials = JSON.parse(process.env.TYPEROLL_BUILD_MEDIA_ACCESS ?? ''); }
  catch { throw new Error('Media build access is missing or expired. Redeploy from Typeroll, or provide scoped R2 build credentials when building independently.'); }
  let grants;
  if (credentials.grant_url) {
    const location = new URL(credentials.grant_url);
    if (location.protocol !== 'https:' || location.hostname !== `${manifest.account_id}.r2.cloudflarestorage.com`) throw new Error('Unexpected media grant origin');
    const response = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Media build access expired. Redeploy from Typeroll.');
    const bytes = await boundedBytes(response.body, 32 * 1024 * 1024);
    if (hash(bytes) !== credentials.sha256) throw new Error('Media grants failed integrity verification');
    grants = JSON.parse(bytes.toString());
    if (grants.publication_id !== publication.publication_id || grants.expires_at <= Date.now()) throw new Error('Media grants do not match this publication or have expired');
    credentials = grants;
  }
  if (credentials.account_id !== manifest.account_id || credentials.original_bucket !== manifest.original_bucket || credentials.public_bucket !== manifest.public_bucket) throw new Error('Media build access belongs to another publication target');
  const client = access => new S3Client({ region: 'auto', endpoint: `https://${manifest.account_id}.r2.cloudflarestorage.com`, credentials: access,
    forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const source = grants ? null : client(credentials.original);
  const target = grants ? null : client(credentials.public);
  async function request(url, options = {}) {
    if (!url) throw new Error('This object is outside the publication grant');
    const location = new URL(url);
    if (location.protocol !== 'https:' || location.hostname !== `${manifest.account_id}.r2.cloudflarestorage.com`) throw new Error('Unexpected media storage origin');
    return fetch(location, { ...options, redirect: 'error', signal: AbortSignal.timeout(60000) });
  }
  async function read(bucket, key, original = false) {
    if (grants) {
      const response = await request(original ? grants.originals[key] : grants.objects[key]?.get);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Could not read media. Check or renew publication access.');
      return boundedBytes(response.body);
    }
    try { const result = await (original ? source : target).send(new GetObjectCommand({ Bucket: bucket, Key: key })); return await boundedBytes(result.Body); }
    catch (error) { if (error?.$metadata?.httpStatusCode === 404) return null; throw new Error('Could not read media. Check or renew publication access.'); }
  }
  async function write(key, bytes, contentType) {
    if (grants) {
      const grant = grants.objects[key];
      const response = await request(grant?.put, { method: 'PUT', headers: grant?.headers, body: bytes });
      if (!response.ok && response.status !== 412) throw new Error('Could not upload a publication asset');
    } else {
      try { await target.send(new PutObjectCommand({ Bucket: manifest.public_bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: cache, IfNoneMatch: '*' })); }
      catch (error) { if (error?.$metadata?.httpStatusCode !== 412) throw new Error('Could not upload a publication asset'); }
    }
  }
  const sameHostFiles = [];
  try {
    for (const entry of manifest.entries) {
      if (!entry.source_key.startsWith(`private/${manifest.site_prefix}/originals/`) || !entry.public_key.startsWith(`${manifest.site_prefix}/`)) throw new Error('Media entry escaped its site namespace');
      const bytes = await read(manifest.original_bucket, entry.source_key, true);
      if (!bytes || hash(bytes) !== entry.sha256 || (entry.size_bytes && bytes.length !== entry.size_bytes)) throw new Error('Original image failed SHA-256 verification');
      async function store(bytes, key, contentType, publicPath, copyToWebsite = true) {
        if (!key.startsWith(`${manifest.site_prefix}/`)) throw new Error('Media alias escaped its site namespace');
        const digest = hash(bytes);
        const existing = await read(manifest.public_bucket, key);
        if (existing && hash(existing) !== digest) throw new Error('A public media path already contains different bytes. Choose a new path to preserve published versions.');
        if (!existing) {
          await write(key, bytes, contentType);
          const verified = await read(manifest.public_bucket, key);
          if (!verified || hash(verified) !== digest) throw new Error('Published media failed byte verification');
        }
        if (copyToWebsite && (manifest.delivery === 'static' || manifest.media_host === manifest.website_host)) {
          const destination = path.resolve(root, '.publication-media', publicPath.slice(1));
          if (!destination.startsWith(path.resolve(root, '.publication-media') + path.sep)) throw new Error('Invalid media output path');
          const retained = await fs.readFile(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (retained && hash(retained) !== hash(bytes)) throw new Error('Static media paths contain conflicting retained assets');
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, bytes);
          sameHostFiles.push({ source: destination, path: publicPath });
        }
      }
      await store(bytes, entry.public_key, entry.mime_type, entry.public_path);
      for (const alias of entry.aliases ?? []) if (alias.key !== entry.public_key) await store(bytes, alias.key, entry.mime_type, new URL(alias.url).pathname, false);
      const media = publication.media.find(item => item.id === entry.id);
      if (imageTypes.has(entry.mime_type)) {
        const metadata = await sharp(bytes).metadata();
        media.width = metadata.width; media.height = metadata.height; media.variants = [];
        for (const width of [320, 640, 1024, 1920]) {
          if (width >= metadata.width) continue;
          for (const format of ['webp', 'avif']) {
            const variant = await sharp(bytes).resize({ width, withoutEnlargement: true })[format]({ quality: format === 'avif' ? 60 : 80 }).toBuffer();
            // Version the transformation recipe; immutable conditional writes detect any encoder mismatch.
            const suffix = `.v1.w${width}.${entry.sha256.slice(0, 16)}.${format}`;
            const key = entry.public_key + suffix;
            const publicPath = entry.public_path + suffix;
            await store(variant, key, `image/${format}`, publicPath);
            for (const alias of entry.aliases ?? []) if (alias.key !== entry.public_key) await store(variant, alias.key + suffix, `image/${format}`, new URL(alias.url).pathname + suffix, false);
            media.variants.push({ width, format, size_bytes: variant.length, cdn_url: entry.cdn_url + suffix });
          }
        }
      }
    }
  } finally { source?.destroy(); target?.destroy(); }
  return [...retainedFiles, ...sameHostFiles];
}
