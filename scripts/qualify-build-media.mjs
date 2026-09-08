import { Agent } from 'node:https';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createBuildMediaGrants } from '../packages/portal/src/lib/publishing/r2-build-grants.ts';
import { prepareMedia } from '../scripts/fixtures/static-publication/media.mjs';
const accountId = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET;
assert.equal(bucket, 'typeroll-selfhost-e2e-media');
const prefix = `_typeroll/scoped-proof/${randomUUID()}`;
const sourceKey = `private/${prefix}/originals/file.png`;
const targetKey = `${prefix}/image.png`;
const bytes = await sharp({ create: { width: 700, height: 400, channels: 3, background: '#345678' } }).png().toBuffer();
const sha256 = createHash('sha256').update(bytes).digest('hex');
const client = new S3Client({ requestHandler: { httpsAgent: new Agent({ family: 4 }), requestTimeout: 15000 }, region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }, forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const manifest = { account_id: accountId, original_bucket: bucket, public_bucket: bucket, site_prefix: prefix, media_host: 'media.test.invalid', website_host: 'site.test.invalid', entries: [{ id: 'proof', source_key: sourceKey, public_key: targetKey, sha256, size_bytes: bytes.length, mime_type: 'image/png', public_path: '/image.png', cdn_url: 'https://media.test.invalid/image.png', aliases: [] }] };
const publication = { publication_id: 'a'.repeat(64), media_manifest: manifest, media: [{ id: 'proof' }] };
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-grant-proof-'));
try {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: sourceKey, Body: bytes }));
  const access = await createBuildMediaGrants(client, manifest, publication.publication_id, 300);
  process.env.TYPEROLL_BUILD_MEDIA_ACCESS = JSON.stringify(access);
  await prepareMedia(publication, root);
  assert.equal(publication.media[0].variants.length, 4);
  await prepareMedia(publication, root);
  console.log(JSON.stringify({ check: 'real original read, responsive variants, public write, hash verification, idempotent rebuild', passed: true }));
  const grants = await (await fetch(access.grant_url)).json();
  const changed = new URL(grants.objects[targetKey].put); changed.pathname += '/other-site';
  const denied = await fetch(changed, { method: 'PUT', headers: grants.objects[targetKey].headers, body: 'forbidden' });
  assert.equal(denied.status, 403);
  const overwrite = await fetch(grants.objects[targetKey].put, { method: 'PUT', headers: grants.objects[targetKey].headers, body: 'forbidden' });
  assert.equal(overwrite.status, 412);
  const original = await client.send(new GetObjectCommand({ Bucket: bucket, Key: targetKey }));
  assert.equal(createHash('sha256').update(await original.Body.transformToByteArray()).digest('hex'), sha256);
  console.log(JSON.stringify({ check: 'other object denied and existing public bytes cannot be overwritten', passed: true }));
} catch (error) {
  console.log(JSON.stringify({ result: 'failed', kind: error?.name, status: error?.$metadata?.httpStatusCode ?? null })); process.exitCode = 1;
} finally {
  delete process.env.TYPEROLL_BUILD_MEDIA_ACCESS;
  for (const cleanupPrefix of [prefix + '/', `private/${prefix}/`, `build-grants/${prefix}/`]) {
    const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: cleanupPrefix }));
    for (const object of objects.Contents ?? []) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
  }
  await fs.rm(root, { recursive: true, force: true });
  client.destroy();
  console.log(JSON.stringify({ cleanup: 'complete' }));
}
