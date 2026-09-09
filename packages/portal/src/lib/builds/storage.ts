import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getConnection, openCredentials, ConnectionError } from '../publishing/connections';
import { cloudflareClient } from '../publishing/cloudflare-oauth';
import { assertPrivateOriginalBucket } from '../publishing/cloudflare-connection';
import type { CloudflareCredentials } from '../publishing/cloudflare-connection';
import { MAX_ARTIFACT_BYTES, sha256 } from './contract.mjs';

/** Private organization storage. Only exact object grants leave the coordinator. */
export async function buildStorage<T>(org: string, work: (storage: {
  account: string; put: (key: string, bytes: Buffer) => Promise<void>;
  read: (key: string, limit?: number) => Promise<Buffer>; grant: (key: string, write?: boolean) => Promise<string>;
}) => Promise<T>): Promise<T> {
  const connection = await getConnection(org, 'cloudflare');
  if (connection.status !== 'connected' || !connection.media_ready || !connection.cloudflare?.bucket || !connection.encrypted_credentials)
    throw new ConnectionError('Prepare Media storage in Publishing before setting up shared builds.', 409, 'build_storage_required');
  if (connection.cloudflare.bucket === connection.cloudflare.public_bucket) throw new ConnectionError('Build storage must use the private originals bucket.', 409);
  const provider = await cloudflareClient(org);
  await assertPrivateOriginalBucket(provider, connection.cloudflare.account_id, connection.cloudflare.bucket);
  const credentials = openCredentials<CloudflareCredentials>(org, 'cloudflare', connection.encrypted_credentials);
  const account = connection.cloudflare.account_id, bucket = connection.cloudflare.bucket;
  const client = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, forcePathStyle: true,
    credentials: { accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const keyFor = (key: string) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(org) || !key.startsWith(`builds/${org}/`) || key.split('/').some(p => !/^[a-zA-Z0-9_.-]+$/.test(p) || p === '.' || p === '..')) throw new Error('Invalid private build object scope');
    return key;
  };
  const read = async (key: string, limit = MAX_ARTIFACT_BYTES) => {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(key) }));
    if (!result.Body || (result.ContentLength ?? 0) > limit) throw new ConnectionError('Build object exceeds its size limit.', 413);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > limit) { (result.Body as { destroy?: () => void }).destroy?.(); throw new ConnectionError('Build object exceeds its size limit.', 413); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
  try { return await work({ account, read,
    put: async (key, bytes) => {
      if (bytes.length > MAX_ARTIFACT_BYTES) throw new ConnectionError('Build object exceeds its size limit.', 413);
      try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(key), Body: bytes, ContentType: 'application/json', CacheControl: 'private, no-store', IfNoneMatch: '*' })); }
      catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
        if (sha256(await read(key)) !== sha256(bytes)) throw new ConnectionError('Frozen build object changed.', 409); }
    },
    grant: (key, write = false) => getSignedUrl(client, write
      ? new PutObjectCommand({ Bucket: bucket, Key: keyFor(key), ContentType: 'application/json' })
      : new GetObjectCommand({ Bucket: bucket, Key: keyFor(key) }), { expiresIn: 900 }),
  }); } finally { client.destroy(); }
}

/** Expire temporary inputs and artifacts while keeping verification manifests for later deletions. */
export async function prepareBuildRetention(org: string) {
  const connection = await getConnection(org, 'cloudflare');
  if (!connection.cloudflare?.bucket || !connection.media_ready) throw new ConnectionError('Prepare Media storage first.', 409);
  const provider = await cloudflareClient(org);
  await assertPrivateOriginalBucket(provider, connection.cloudflare.account_id, connection.cloudflare.bucket);
  const endpoint = `/accounts/${connection.cloudflare.account_id}/r2/buckets/${connection.cloudflare.bucket}/lifecycle`;
  const existing = await provider(endpoint, { missing: true });
  const rules = ['sources', 'tasks'].map(kind => ({ id: `typeroll-build-${kind}`, enabled: true, conditions: { prefix: `builds/${org}/${kind}/` }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604800 } } }));
  await provider(endpoint, { method: 'PUT', body: { rules: [...(existing?.rules ?? []).filter((rule: { id: string }) => !rules.some(ours => ours.id === rule.id)), ...rules] } });
  const saved = await provider(endpoint);
  if (rules.some(rule => !saved.rules?.some((value: any) => value.id === rule.id && value.enabled && value.conditions?.prefix === rule.conditions.prefix && value.deleteObjectsTransition?.condition?.maxAge === 604800))) throw new ConnectionError('Cloudflare did not confirm temporary build storage retention.', 502);
}
