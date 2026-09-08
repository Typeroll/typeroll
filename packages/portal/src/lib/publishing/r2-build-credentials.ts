import { S3Client } from '@aws-sdk/client-s3';
import { getConnection, openCredentials, ConnectionError } from './connections';
import type { CloudflareCredentials } from './cloudflare-connection';
import { siteMediaPrefix } from '../media-keys';
import { createBuildMediaGrants } from './r2-build-grants';

export async function customerBuildMediaAccess(orgId: string, siteId: string, manifest: any, publicationId: string, retained: any[] = []) {
  const connection = await getConnection(orgId, 'cloudflare');
  if (connection.status !== 'connected' || !connection.media_ready || !connection.cloudflare?.public_bucket || !connection.encrypted_credentials) {
    throw new ConnectionError('Prepare private and public media storage in Publishing before deploying images.', 409, 'media_storage_required');
  }
  const credentials = openCredentials<CloudflareCredentials>(orgId, 'cloudflare', connection.encrypted_credentials);
  const prefix = await siteMediaPrefix(orgId, siteId);
  const accountId = connection.cloudflare.account_id;
  manifest ??= retained[0];
  if (manifest.site_prefix !== prefix || manifest.account_id !== accountId || manifest.original_bucket !== connection.cloudflare.bucket || manifest.public_bucket !== connection.cloudflare.public_bucket) throw new ConnectionError('Media storage changed. Start a new publication.', 409);
  const client = new S3Client({ region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key }, forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  try {
    for (const previous of retained) if (previous.account_id !== accountId || previous.original_bucket !== manifest.original_bucket || previous.public_bucket !== manifest.public_bucket || previous.site_prefix !== prefix) throw new ConnectionError('Retained media belongs to another storage target.', 409);
    return await createBuildMediaGrants(client, { ...manifest, entries: [...manifest.entries, ...retained.flatMap(previous => previous.entries)] }, publicationId);
  }
  finally { client.destroy(); }
}
