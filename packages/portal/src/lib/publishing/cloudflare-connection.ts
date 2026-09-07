import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { FullSession } from '../access';
import { isSecretCryptoConfigured } from '../secret-crypto';
import { claimAccount, ConnectionError, getConnection, saveConnection, sealCredentials } from './connections';
import { createProviderClient } from './providers.mjs';

export interface CloudflareCredentials { api_token: string; access_key_id: string; secret_access_key: string }
interface CloudflareInput extends CloudflareCredentials { account_id: string; bucket: string; revision: string }

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
  try {
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'text/plain' }), { abortSignal: AbortSignal.timeout(15_000) });
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
      if (await response.Body?.transformToString() !== body) throw new Error();
    } finally {
      // Also clean up an ambiguous upload that timed out after the object was stored.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
    }
  } catch { throw new ConnectionError('R2 upload, readback, or cleanup failed. Check bucket credentials and try again.', 502); }
  finally { client.destroy(); }
}

export async function connectCloudflare(session: FullSession, input: unknown, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!isSecretCryptoConfigured()) throw new ConnectionError('The publisher has not configured encrypted credential storage', 503);
  const data = parseInput(input);
  const current = await getConnection(session.orgId, 'cloudflare');
  if (current.revision !== data.revision) throw new ConnectionError('The connection changed. Reload the page and try again.', 409);
  if (current.cloudflare && (current.cloudflare.account_id !== data.account_id || current.cloudflare.bucket !== data.bucket)) {
    throw new ConnectionError('Reconnect the original Cloudflare account and bucket; moving media is a separate operation', 409);
  }
  const cloudflare = createProviderClient('Cloudflare', data.api_token, fetchImpl);
  const account = await cloudflare(`/accounts/${data.account_id}`);
  if (account.id !== data.account_id || typeof account.name !== 'string') throw new ConnectionError('Cloudflare account verification failed', 502);
  await cloudflare(`/accounts/${data.account_id}/pages/projects?per_page=1`);
  const credentials = { api_token: data.api_token, access_key_id: data.access_key_id, secret_access_key: data.secret_access_key };
  await verifyR2(data.account_id, data.bucket, credentials);
  await claimAccount(session.orgId, 'cloudflare', data.account_id);
  await saveConnection(session.orgId, 'cloudflare', data.revision, {
    status: 'connected', connected_at: new Date().toISOString(), connected_by: session.userId,
    cloudflare: { account_id: data.account_id, account_name: account.name.slice(0, 200), bucket: data.bucket,
      endpoint: `https://${data.account_id}.r2.cloudflarestorage.com` },
    encrypted_credentials: sealCredentials(session.orgId, 'cloudflare', credentials),
  });
}
