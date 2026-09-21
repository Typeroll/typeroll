import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { mediaReceiptKey } from './media-receipt.mjs';
import { MEDIA_RECIPE_VERSION, MEDIA_VARIANT_WIDTHS, mediaVariantCandidates, mediaVariantSuffix } from './media-recipe.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cache = 'public, max-age=31536000, immutable';
async function boundedBytes(response, limit = 25 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of response) { size += chunk.length; if (size > limit) throw new Error('Media response is too large'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
const recipe = { version: MEDIA_RECIPE_VERSION, encoder: sharp.versions, widths: MEDIA_VARIANT_WIDTHS, include_original: true, quality: { webp: 80, avif: 60 } };
const recipeHash = hash(JSON.stringify(recipe));
// Encoding has its own CPU gate, separate from overlapping storage transfers.
let encoding = false; const encoders = [];
async function encode(operation) {
  await new Promise(resolve => { if (!encoding) { encoding = true; resolve(); } else encoders.push(resolve); });
  try { return await operation(); }
  finally { const next = encoders.shift(); if (next) next(); else encoding = false; }
}
// Reserve original, comparison and verification buffers plus variant overhead.
// Small files can overlap; large or unknown files reduce the group automatically.
let transferConcurrency = 16, healthyTransfers = 0;
export function mediaTransferGroupSize(entries, cursor, maximum = transferConcurrency) {
  let bytes = 0, count = 0;
  while (cursor + count < entries.length && count < maximum) {
    const entry = entries[cursor + count].entry ?? entries[cursor + count];
    const size = Number.isSafeInteger(entry.size_bytes) && entry.size_bytes > 0 && entry.size_bytes <= 25 * 1024 * 1024 ? entry.size_bytes : 25 * 1024 * 1024;
    const reserved = size * 3 + 8 * 1024 * 1024;
    if (bytes + reserved > 200 * 1024 * 1024) break;
    bytes += reserved; count++;
  }
  return count;
}
function recoveredTransfers(count) {
  healthyTransfers += count;
  if (healthyTransfers >= 16) { transferConcurrency = Math.min(16, transferConcurrency + 1); healthyTransfers = 0; }
}
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

/** Runs on the customer's build machine. No original or generated image is committed to Git. */
export async function prepareMedia(publication, root, options = {}) {
  options.access ??= {};
  const retainedFiles = [];
  for (const previous of publication.retained_media_manifests ?? []) {
    retainedFiles.push(...await prepareMedia({ ...publication, media_manifest: previous, media: previous.entries.map(entry => ({ ...entry })), retained_media_manifests: [] }, root, options));
  }
  const manifest = publication.media_manifest;
  if (!manifest?.entries?.length) return retainedFiles;
  let credentials;
  try { credentials = options.access.credentials ?? JSON.parse(process.env.TYPEROLL_BUILD_MEDIA_ACCESS ?? ''); }
  catch { throw new Error('Media build access is missing or expired. Redeploy from Typeroll, or provide scoped R2 build credentials when building independently.'); }
  let grants = credentials.objects && credentials.originals ? credentials : null;
  if (credentials.grant_url) {
    const location = new URL(credentials.grant_url);
    if (location.protocol !== 'https:' || location.hostname !== `${manifest.account_id}.r2.cloudflarestorage.com`) throw new Error('Unexpected media grant origin');
    const response = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(30000) }).catch(() => { throw new Error('media_transfer_interrupted'); });
    if (response.status === 429 || response.status >= 500) { await response.body?.cancel(); throw new Error('media_transfer_interrupted'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error('Media build access expired. Redeploy from Typeroll.'); }
    const bytes = await boundedBytes(response.body, 32 * 1024 * 1024).catch(error => {
      if (error.message === 'Media response is too large') throw error;
      throw new Error('media_transfer_interrupted');
    });
    if (hash(bytes) !== credentials.sha256) throw new Error('Media grants failed integrity verification');
    grants = JSON.parse(bytes.toString());
    if (grants.publication_id !== publication.publication_id || grants.expires_at <= Date.now()) throw new Error('Media grants do not match this publication or have expired');
    credentials = grants;
    options.access.credentials = grants;
  }
  if (grants && (grants.publication_id !== publication.publication_id || grants.expires_at <= Date.now())) throw new Error('Media grants do not match this publication or have expired');
  if (credentials.account_id !== manifest.account_id || credentials.original_bucket !== manifest.original_bucket || credentials.public_bucket !== manifest.public_bucket) throw new Error('Media build access belongs to another publication target');
  options.access.credentials = credentials;
  const client = access => new S3Client({ region: 'auto', endpoint: `https://${manifest.account_id}.r2.cloudflarestorage.com`, credentials: access,
    forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const source = grants ? null : client(credentials.original);
  const target = grants ? null : client(credentials.public);
  async function request(url, options = {}) {
    if (!url) throw new Error('This object is outside the publication grant');
    const location = new URL(url);
    if (location.protocol !== 'https:' || location.hostname !== `${manifest.account_id}.r2.cloudflarestorage.com`) throw new Error('Unexpected media storage origin');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(location, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (response.status === 429 || response.status >= 500) {
          const value = response.headers.get('retry-after');
          const delay = value ? (Number.isFinite(Number(value)) ? Number(value) * 1000 : Date.parse(value) - Date.now()) : 0;
          await response.body?.cancel();
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(delay, 30000)));
          throw new Error('media_transfer_interrupted');
        }
        return response;
      } catch {
        transferConcurrency = Math.max(1, Math.floor(transferConcurrency / 2)); healthyTransfers = 0;
        if (attempt === 2) throw new Error('media_transfer_interrupted');
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
  async function read(bucket, key, original = false) {
    if (grants) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await request(original ? grants.originals[key] : grants.objects[key]?.get);
        if (response.status === 404) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new Error('Could not read media. Check or renew publication access.'); }
        try { return await boundedBytes(response.body); }
        catch (error) {
          if (error.message === 'Media response is too large') throw error;
          if (attempt === 2) throw new Error('media_transfer_interrupted');
          await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    }
    try { const result = await (original ? source : target).send(new GetObjectCommand({ Bucket: bucket, Key: key })); return await boundedBytes(result.Body); }
    catch (error) { if (error?.$metadata?.httpStatusCode === 404) return null; throw new Error('Could not read media. Check or renew publication access.'); }
  }
  async function write(key, bytes, contentType) {
    if (grants) {
      const grant = grants.objects[key];
      const response = await request(grant?.put, { method: 'PUT', headers: grant?.headers, body: bytes });
      await response.body?.cancel();
      if (!response.ok && response.status !== 412) throw new Error('Could not upload a publication asset');
    } else {
      try { await target.send(new PutObjectCommand({ Bucket: manifest.public_bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: cache, IfNoneMatch: '*' })); }
      catch (error) { if (error?.$metadata?.httpStatusCode !== 412) throw new Error('Could not upload a publication asset'); }
    }
  }
  const sameHostFiles = [];
  try {
    const prepareEntry = async entry => {
      if (!entry.source_key.startsWith(`private/${manifest.site_prefix}/originals/`) || !entry.public_key.startsWith(`${manifest.site_prefix}/`)) throw new Error('Media entry escaped its site namespace');
      const completionKey = mediaReceiptKey(manifest, entry);
      const canComplete = !options.cacheOnly && (!grants || Boolean(grants.objects[completionKey]));
      const completionBytes = canComplete ? await read(manifest.public_bucket, completionKey) : null;
      const media = publication.media.find(item => item.id === entry.id);
      if (completionBytes) {
        const completed = JSON.parse(completionBytes.toString());
        if (completed.format !== 1 || completed.key !== completionKey || completed.recipe_sha256 !== recipeHash ||
            !Array.isArray(completed.variants)) throw new Error('Invalid media completion receipt');
        const expected = imageTypes.has(entry.mime_type) ? mediaVariantCandidates(completed.width).flatMap(({ width }) => ['webp', 'avif'].map(format => ({ width, format }))) : [];
        if ((imageTypes.has(entry.mime_type) && (!Number.isSafeInteger(completed.width) || completed.width < 1 || !Number.isSafeInteger(completed.height) || completed.height < 1)) ||
            expected.length !== completed.variants.length || expected.some((variant, index) => {
              const actual = completed.variants[index];
              return actual.width !== variant.width || actual.format !== variant.format || !/^[a-f0-9]{64}$/.test(actual.sha256) || !Number.isSafeInteger(actual.size_bytes) || actual.size_bytes < 1;
            })) throw new Error('Invalid media completion receipt');
        media.width = completed.width; media.height = completed.height;
        media.variants = completed.variants.map(variant => ({ width: variant.width, format: variant.format, size_bytes: variant.size_bytes,
          cdn_url: entry.cdn_url + mediaVariantSuffix(variant.width === completed.width ? 'original' : `w${variant.width}`, entry.sha256, variant.format) }));
        // A durable completion receipt replaces library-wide revalidation. Only
        // artifacts included in this static output need downloading and hashing.
        if (!options.prepareOnly && (manifest.delivery === 'static' || manifest.media_host === manifest.website_host)) {
          const artifacts = [{ key: entry.source_key, original: true, sha256: entry.sha256, size_bytes: entry.size_bytes, path: entry.public_path },
            ...completed.variants.map(variant => { const suffix = mediaVariantSuffix(variant.width === completed.width ? 'original' : `w${variant.width}`, entry.sha256, variant.format); return { ...variant, key: entry.public_key + suffix, path: entry.public_path + suffix }; })];
          for (const artifact of artifacts) {
            const reusable = options.reusableFiles?.[artifact.path.slice(1)];
            if (reusable?.sha256 === artifact.sha256 && reusable.size === artifact.size_bytes) {
              sameHostFiles.push({ path: artifact.path, reused: true, sha256: artifact.sha256, size: artifact.size_bytes });
              continue;
            }
            const destination = path.resolve(root, '.publication-media', artifact.path.slice(1));
            if (!destination.startsWith(path.resolve(root, '.publication-media') + path.sep)) throw new Error('Invalid media output path');
            let bytes = await fs.readFile(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (!bytes) bytes = await read(artifact.original ? manifest.original_bucket : manifest.public_bucket, artifact.key, artifact.original);
            if (!bytes || hash(bytes) !== artifact.sha256 || (artifact.size_bytes && bytes.length !== artifact.size_bytes)) throw new Error('Prepared media failed byte verification');
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, bytes);
            sameHostFiles.push({ source: destination, path: artifact.path });
          }
        }
        return;
      }
      const completedVariants = [];
      const bytes = await read(manifest.original_bucket, entry.source_key, true);
      if (!bytes || hash(bytes) !== entry.sha256 || (entry.size_bytes && bytes.length !== entry.size_bytes)) throw new Error('Original image failed SHA-256 verification');
      async function store(bytes, key, contentType, publicPath, copyToWebsite = true, verifiedExisting = undefined) {
        if (!key.startsWith(`${manifest.site_prefix}/`)) throw new Error('Media alias escaped its site namespace');
        const digest = hash(bytes);
        if (!options.materializeOnly) {
          const existing = verifiedExisting === undefined ? await read(manifest.public_bucket, key) : verifiedExisting;
          if (existing && hash(existing) !== digest) throw new Error('A public media path already contains different bytes. Choose a new path to preserve published versions.');
          if (!existing) {
            await write(key, bytes, contentType);
            const verified = await read(manifest.public_bucket, key);
            if (!verified || hash(verified) !== digest) throw new Error('Published media failed byte verification');
          }
        }
        if (copyToWebsite && !options.prepareOnly && (manifest.delivery === 'static' || manifest.media_host === manifest.website_host)) {
          const destination = path.resolve(root, '.publication-media', publicPath.slice(1));
          if (!destination.startsWith(path.resolve(root, '.publication-media') + path.sep)) throw new Error('Invalid media output path');
          const retained = await fs.readFile(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (retained && hash(retained) !== hash(bytes)) throw new Error('Static media paths contain conflicting retained assets');
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, bytes);
          sameHostFiles.push({ source: destination, path: publicPath });
        }
      }
      if (!options.cacheOnly) await store(bytes, entry.public_key, entry.mime_type, entry.public_path);
      for (const alias of options.cacheOnly || options.materializeOnly ? [] : entry.aliases ?? []) if (alias.key !== entry.public_key) await store(bytes, alias.key, entry.mime_type, new URL(alias.url).pathname, false);
      if (imageTypes.has(entry.mime_type)) {
        const metadata = await sharp(bytes).metadata();
        media.width = metadata.width; media.height = metadata.height; media.variants = [];
        for (const { width, slot } of mediaVariantCandidates(metadata.width)) {
          for (const format of ['webp', 'avif']) {
            // A receipt is written only after reading back the immutable variant.
            // It binds reuse to the original, exact encoder and transformation recipe.
            const suffix = mediaVariantSuffix(slot, entry.sha256, format);
            const key = entry.public_key + suffix;
            const receiptKey = key + '.receipt.json';
            const publicPath = entry.public_path + suffix;
            const hasReceiptAccess = !grants || Boolean(grants.objects[receiptKey]);
            const receiptBytes = !options.cacheOnly && hasReceiptAccess ? await read(manifest.public_bucket, receiptKey) : null;
            let variant, verifiedVariant;
            if (receiptBytes) {
              let receipt;
              try { receipt = JSON.parse(receiptBytes.toString()); } catch { throw new Error('Invalid media preparation receipt'); }
              if (receipt.source_sha256 !== entry.sha256 || receipt.recipe_sha256 !== recipeHash || receipt.width !== width || receipt.format !== format ||
                  !/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.size_bytes) || receipt.size_bytes < 1) throw new Error('Media preparation recipe changed. Prepare a new versioned media path.');
              variant = await read(manifest.public_bucket, key);
              if (variant && (hash(variant) !== receipt.sha256 || variant.length !== receipt.size_bytes)) throw new Error('Prepared media failed byte verification');
              verifiedVariant = variant;
            }
            const preparedKey = `private/${manifest.site_prefix}/prepared/${MEDIA_RECIPE_VERSION}/${entry.sha256}/${slot}.${format}`;
            const cachedGrant = grants?.prepared?.[preparedKey], cachedReceiptGrant = grants?.prepared?.[preparedKey + '.receipt.json'];
            let cachedReceipt;
            if (!options.materializeOnly && cachedReceiptGrant) {
              const response = await request(cachedReceiptGrant.get);
              if (response.ok) {
                cachedReceipt = JSON.parse((await boundedBytes(response.body, 8192)).toString());
                if (cachedReceipt.source_sha256 === entry.sha256 && cachedReceipt.recipe_sha256 === recipeHash && cachedReceipt.width === width && cachedReceipt.format === format) {
                  // A public variant may already be verified. Read its private
                  // receipt too, so warm builds do not repeat conditional PUTs.
                  if (!variant) {
                    const cached = await request(cachedGrant.get);
                    if (cached.ok) variant = await boundedBytes(cached.body);
                    else { await cached.body?.cancel(); if (cached.status !== 404) throw new Error('media_transfer_interrupted'); }
                  }
                  if (variant && (hash(variant) !== cachedReceipt.sha256 || variant.length !== cachedReceipt.size_bytes)) throw new Error('Prepared media failed byte verification');
                }
              } else { await response.body?.cancel(); if (response.status !== 404) throw new Error('media_transfer_interrupted'); }
            }
            if (!variant && options.materializeOnly) throw new Error('Prepared media is unavailable. Redeploy to prepare the missing variant.');
            if (!variant) variant = await encode(() => sharp(bytes).resize({ width, withoutEnlargement: true })[format]({ quality: recipe.quality[format] }).toBuffer());
            if (!options.materializeOnly && !cachedReceipt && cachedGrant && cachedReceiptGrant) {
              const saved = await request(cachedGrant.put, { method: 'PUT', headers: cachedGrant.headers, body: variant });
              await saved.body?.cancel();
              if (!saved.ok && saved.status !== 412) throw new Error('media_transfer_interrupted');
              const verified = await request(cachedGrant.get);
              if (!verified.ok || hash(await boundedBytes(verified.body)) !== hash(variant)) throw new Error('Prepared media failed byte verification');
              const body = JSON.stringify({ source_sha256: entry.sha256, recipe_sha256: recipeHash, width, format, sha256: hash(variant), size_bytes: variant.length });
              const savedReceipt = await request(cachedReceiptGrant.put, { method: 'PUT', headers: cachedReceiptGrant.headers, body });
              await savedReceipt.body?.cancel();
              if (!savedReceipt.ok && savedReceipt.status !== 412) throw new Error('media_transfer_interrupted');
            }
            if (options.cacheOnly) continue;
            await store(variant, key, `image/${format}`, publicPath, true, verifiedVariant);
            const receipt = Buffer.from(JSON.stringify({ source_sha256: entry.sha256, recipe_sha256: recipeHash, width, format, sha256: hash(variant), size_bytes: variant.length }));
            if (hasReceiptAccess && !options.materializeOnly) await store(receipt, receiptKey, 'application/json', '', false, receiptBytes);
            for (const alias of options.materializeOnly ? [] : entry.aliases ?? []) if (alias.key !== entry.public_key) await store(variant, alias.key + suffix, `image/${format}`, new URL(alias.url).pathname + suffix, false);
            media.variants.push({ width, format, size_bytes: variant.length, cdn_url: entry.cdn_url + suffix });
            completedVariants.push({ width, format, sha256: hash(variant), size_bytes: variant.length });
          }
        }
      }
      // Publish last: a partial or interrupted preparation never counts as ready.
      if (canComplete && !options.materializeOnly) {
        const receipt = Buffer.from(JSON.stringify({ format: 1, key: completionKey, recipe_sha256: recipeHash,
          width: media.width, height: media.height, variants: completedVariants }));
        await store(receipt, completionKey, 'application/json', '', false);
      }
    };
    // Bounded parallel reads keep final materialization from becoming another
    // library-wide timeout. Drain the group before closing clients on failure.
    for (let offset = 0; offset < manifest.entries.length;) {
      const count = options.prepareOnly ? 1 : mediaTransferGroupSize(manifest.entries, offset);
      const results = await Promise.allSettled(manifest.entries.slice(offset, offset + count).map(prepareEntry));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      offset += count; recoveredTransfers(count);
    }
  } finally { source?.destroy(); target?.destroy(); }
  return [...retainedFiles, ...sameHostFiles];
}

/** Prepare a bounded slice of the frozen library; the coordinator owns the cursor. */
export async function prepareMediaBatch(publication, root, cursor = 0, { maxEntries = 100, budgetMs = 120000, clock = Date.now, cacheOnly = false, materialize = false, reusableFiles = {}, access = {} } = {}) {
  const manifests = [...(publication.retained_media_manifests ?? []), ...(publication.media_manifest ? [publication.media_manifest] : [])];
  const entries = manifests.flatMap(manifest => manifest.entries.map(entry => ({ manifest, entry })));
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > entries.length || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Invalid media preparation cursor');
  const started = clock(), files = [], media = []; let next = cursor;
  while (next < entries.length && next - cursor < maxEntries && (next === cursor || clock() - started < budgetMs)) {
    // Prime the shared grant once, then overlap independent files. Only a fully
    // verified contiguous group advances the cursor; drain siblings on failure.
    const size = next === cursor ? 1 : mediaTransferGroupSize(entries, next, Math.min(transferConcurrency, maxEntries - (next - cursor)));
    const group = entries.slice(next, next + size);
    const results = await Promise.allSettled(group.map(async ({ manifest, entry }) => {
      const prepared = { ...publication, retained_media_manifests: [], media_manifest: { ...manifest, entries: [entry] }, media: [{ ...entry }] };
      const output = await prepareMedia(prepared, root, { prepareOnly: !materialize, materializeOnly: materialize, cacheOnly, access, reusableFiles });
      if (materialize) { files.push(...output); if (manifest === publication.media_manifest) media.push(...prepared.media); }
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    next += group.length;
  }
  return { cursor: next, total: entries.length, ...(materialize ? { files, media } : {}) };
}
