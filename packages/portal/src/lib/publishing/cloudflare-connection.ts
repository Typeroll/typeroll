import { createHash, randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { R2VerificationError, r2Diagnostic, type R2VerificationDiagnostic, type R2VerificationStep } from './r2-verification-error';
import type { FullSession } from '../access';
import { isSecretCryptoConfigured } from '../secret-crypto';
import { claimAccount, ConnectionError, getConnection, saveConnection, sealCredentials, openCredentials } from './connections';
import { createProviderClient } from './providers.mjs';
import { cloudflareClient, type CloudflareStoredCredentials } from './cloudflare-oauth';

export interface CloudflareCredentials { api_token?: string; access_key_id: string; secret_access_key: string }
interface CloudflareInput extends CloudflareCredentials { account_id: string; bucket: string; revision: string }

export async function assertPrivateOriginalBucket(provider: ReturnType<typeof createProviderClient>, accountId: string, bucket: string) {
  const root = `/accounts/${accountId}/r2/buckets/${bucket}/domains`;
  const [managed, custom] = await Promise.all([provider(`${root}/managed`), provider(`${root}/custom`)]);
  if (managed.enabled !== false || !Array.isArray(custom.domains) || custom.domains.some((domain: { enabled?: boolean }) => domain.enabled !== false)) {
    throw new ConnectionError('The originals bucket must be private. In Cloudflare → R2 object storage → your originals bucket → Settings, disable the Public Development URL and remove public Custom Domains. Use the separate public bucket for published images.', 409, 'private_original_storage_required');
  }
}

function parseInput(input: unknown): CloudflareInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionError('Enter the Cloudflare account and bucket credentials');
  const data = input as Record<string, unknown>;
  for (const key of ['account_id', 'bucket', 'revision', 'api_token', 'access_key_id', 'secret_access_key']) {
    if (typeof data[key] !== 'string' || !data[key] || (data[key] as string).length > 512 || /[\s\x00-\x1f]/.test(data[key] as string)) throw new ConnectionError('Enter all Cloudflare connection fields');
  }
  if (!/^[a-f0-9]{32}$/.test(data.account_id as string) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(data.bucket as string)) {
    throw new ConnectionError('Enter a valid Cloudflare Account ID and R2 bucket name');
  }
  return data as unknown as CloudflareInput;
}

/** Fixed provider endpoint; no customer-supplied URL can receive credentials. */
export async function verifyR2(accountId: string, bucket: string, credentials: CloudflareCredentials): Promise<void> {
  const client = new S3Client({ region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key }, maxAttempts: 1 });
  const key = `_typeroll/connection-checks/${randomUUID()}`;
  const body = randomUUID();
  let step: R2VerificationStep = 'write';
  let failure: R2VerificationDiagnostic | undefined;
  let cleanupFailure: R2VerificationDiagnostic | undefined;
  try {
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'text/plain' }), { abortSignal: AbortSignal.timeout(15_000) });
      step = 'read';
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
      if (await response.Body?.transformToString() !== body) throw { name: 'ContentMismatch' };
    } catch (error) { failure = r2Diagnostic(step, error); }
    // Clean up even an ambiguous upload, but never overwrite the original failure.
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
    } catch (error) {
      const cleanup = r2Diagnostic('delete', error);
      if (failure) cleanupFailure = cleanup;
      else failure = cleanup;
    }
    if (failure) {
      const diagnostic = { ...failure, account_id: accountId, bucket, ...(cleanupFailure ? { cleanup_failure: cleanupFailure } : {}) };
      console.warn('R2 verification failed', diagnostic);
      throw new R2VerificationError(diagnostic);
    }
  } finally { client.destroy(); }
}

export async function connectCloudflare(session: FullSession, input: unknown, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!isSecretCryptoConfigured()) throw new ConnectionError('The publisher has not configured encrypted credential storage', 503);
  const data = parseInput(input);
  const current = await getConnection(session.orgId, 'cloudflare');
  if (current.revision !== data.revision) throw new ConnectionError('The connection changed. Reload the page and try again.', 409);
  if (current.cloudflare && (current.cloudflare.account_id !== data.account_id || current.cloudflare.bucket !== data.bucket)) {
    throw new ConnectionError('Reconnect the original Cloudflare account and bucket; moving media is a separate operation', 409);
  }
  const cloudflare = createProviderClient('Cloudflare', data.api_token!, fetchImpl);
  const account = await cloudflare(`/accounts/${data.account_id}`);
  if (account.id !== data.account_id || typeof account.name !== 'string') throw new ConnectionError('Cloudflare account verification failed', 502);
  await cloudflare(`/accounts/${data.account_id}/pages/projects?per_page=1`);
  await assertPrivateOriginalBucket(cloudflare, data.account_id, data.bucket);
  const credentials = { api_token: data.api_token, access_key_id: data.access_key_id, secret_access_key: data.secret_access_key };
  await verifyR2(data.account_id, data.bucket, credentials);
  await claimAccount(session.orgId, 'cloudflare', data.account_id);
  await saveConnection(session.orgId, 'cloudflare', data.revision, {
    status: 'connected', auth_method: 'api_token', media_ready: false, connected_at: new Date().toISOString(), connected_by: session.userId,
    cloudflare: { account_id: data.account_id, account_name: account.name.slice(0, 200), bucket: data.bucket,
      endpoint: `https://${data.account_id}.r2.cloudflarestorage.com` },
    encrypted_credentials: sealCredentials(session.orgId, 'cloudflare', credentials),
  });
}

/** A stable organization bucket is reused for every site and every retry. */
export async function prepareCloudflareMedia(session: FullSession, revision: string, fetchImpl: typeof fetch = fetch) {
  let origin: string;
  try {
    const url = new URL(process.env.PORTAL_PUBLIC_URL ?? '');
    if (url.username || url.password || (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error();
    origin = url.origin;
  } catch { throw new ConnectionError('The publisher must configure its public address before preparing media.', 503); }
  const current = await getConnection(session.orgId, 'cloudflare');
  if (current.status !== 'connected' || !current.cloudflare || current.revision !== revision) throw new ConnectionError('Reload the Cloudflare connection before preparing media.', 409);
  const provider = await cloudflareClient(session.orgId, fetchImpl, current.revision);
  // OAuth refresh rotates the stored revision. Continue only against the
  // connection that supplied this client, never a concurrent reconnect.
  const authorized = await getConnection(session.orgId, 'cloudflare');
  if (authorized.revision !== provider.connectionRevision || authorized.cloudflare?.account_id !== current.cloudflare.account_id) throw new ConnectionError('The connection changed. Reload and try again.', 409);
  const bucket = current.cloudflare.bucket || `typeroll-media-${createHash('sha256').update(session.orgId).digest('hex').slice(0, 16)}`;
  const root = `/accounts/${current.cloudflare.account_id}/r2/buckets`;
  let existing = await provider(`${root}/${bucket}`, { missing: true });
  if (!existing) {
    await provider(root, { method: 'POST', body: { name: bucket } });
    existing = await provider(`${root}/${bucket}`);
  }
  if (existing.name !== bucket || (existing.jurisdiction && existing.jurisdiction !== 'default')) throw new ConnectionError('The R2 bucket does not match this connection.', 409);
  await assertPrivateOriginalBucket(provider, current.cloudflare.account_id, bucket);
  const publicBucket = current.cloudflare.public_bucket || `typeroll-public-${createHash('sha256').update(session.orgId).digest('hex').slice(0, 16)}`;
  let publicStorage = await provider(`${root}/${publicBucket}`, { missing: true });
  if (!publicStorage) {
    await provider(root, { method: 'POST', body: { name: publicBucket } });
    publicStorage = await provider(`${root}/${publicBucket}`);
  }
  if (publicStorage.name !== publicBucket || (publicStorage.jurisdiction && publicStorage.jurisdiction !== 'default')) throw new ConnectionError('The public R2 bucket does not match this connection.', 409);
  const cors = await provider(`${root}/${bucket}/cors`, { missing: true });
  const rule = { id: 'typeroll-direct-uploads', allowed: { origins: [origin], methods: ['GET', 'HEAD', 'PUT'], headers: ['content-type', 'cache-control', 'x-amz-*'] }, exposeHeaders: ['ETag'], maxAgeSeconds: 3600 };
  await provider(`${root}/${bucket}/cors`, { method: 'PUT', body: { rules: [...(cors?.rules ?? []).filter((item: { id?: string }) => item.id !== rule.id), rule] } });
  const lifecycle = await provider(`${root}/${bucket}/lifecycle`, { missing: true });
  const expiry = { id: 'typeroll-expired-build-grants', enabled: true, conditions: { prefix: 'build-grants/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } } };
  await provider(`${root}/${bucket}/lifecycle`, { method: 'PUT', body: { rules: [...(lifecycle?.rules ?? []).filter((item: { id: string }) => item.id !== expiry.id), expiry] } });
  await saveConnection(session.orgId, 'cloudflare', authorized.revision, { cloudflare: { ...current.cloudflare, bucket, public_bucket: publicBucket } });
  return { bucket, public_bucket: publicBucket };
}

export async function connectCloudflareMedia(session: FullSession, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  const current = await getConnection(session.orgId, 'cloudflare');
  if (current.status !== 'connected' || !current.cloudflare?.bucket || !current.cloudflare.public_bucket || !current.encrypted_credentials || current.revision !== input.revision) throw new ConnectionError('Prepare both media buckets and reload the connection before saving media access.', 409);
  const { access_key_id, secret_access_key } = input;
  if (typeof access_key_id !== 'string' || typeof secret_access_key !== 'string' || !access_key_id || !secret_access_key ||
    access_key_id.length > 512 || secret_access_key.length > 512 || /[\s\x00-\x1f]/.test(access_key_id + secret_access_key)) throw new ConnectionError('Enter both the Access Key ID and Secret Access Key from your Cloudflare R2 token. The Cloudflare API token value is not one of these two keys.', 400, 'r2_credentials_required');
  await verifyR2(current.cloudflare.account_id, current.cloudflare.bucket, { access_key_id, secret_access_key });
  if (current.cloudflare.public_bucket) await verifyR2(current.cloudflare.account_id, current.cloudflare.public_bucket, { access_key_id, secret_access_key });
  // Refresh first, then reread credentials so saving media cannot restore a rotated token.
  const provider = await cloudflareClient(session.orgId, fetchImpl, current.revision);
  await assertPrivateOriginalBucket(provider, current.cloudflare.account_id, current.cloudflare.bucket);
  const latest = await getConnection(session.orgId, 'cloudflare');
  if (latest.revision !== provider.connectionRevision || latest.cloudflare?.account_id !== current.cloudflare.account_id || latest.cloudflare?.bucket !== current.cloudflare.bucket || !latest.encrypted_credentials || latest.refresh_lease) throw new ConnectionError('The connection changed. Reload and try again.', 409);
  const credentials = openCredentials<CloudflareStoredCredentials>(session.orgId, 'cloudflare', latest.encrypted_credentials);
  await saveConnection(session.orgId, 'cloudflare', latest.revision, {
    media_ready: true, encrypted_credentials: sealCredentials(session.orgId, 'cloudflare', { ...credentials, access_key_id, secret_access_key }) });
  const { requestMediaMigration } = await import('./media-migration');
  await requestMediaMigration(session.orgId);
}
