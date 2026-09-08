import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { S3Client, GetObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { paths, type Media } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { createMediaUpload, finalizeStoredMedia, privateMediaReadUrl } from '../../lib/publishing/media-storage';

const account = 'a'.repeat(32);
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.com');
  vi.stubEnv('R2_ACCOUNT_ID', 'b'.repeat(32));
  vi.stubEnv('R2_BUCKET', 'legacy-public');
  vi.stubEnv('R2_PRIVATE_BUCKET', 'private-drafts');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'synthetic-draft-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'synthetic-draft-secret');
  await getStore().setDoc(paths.site('org', 'site'), { media_id: 'abcdefghij', publishing_mode: 'customer_git' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function connect() {
  await getStore().setDoc(connectionPath('org', 'cloudflare'), {
    revision: 'connected-revision', status: 'connected', media_ready: true,
    cloudflare: { account_id: account, bucket: 'customer-private', public_bucket: 'customer-public' },
    encrypted_credentials: sealCredentials('org', 'cloudflare', { access_key_id: 'synthetic-customer-key', secret_access_key: 'synthetic-customer-secret' }),
  });
}

it('uploads directly to the owner account and stores no bearer URLs or credentials', async () => {
  await connect();
  const result = await createMediaUpload('org', 'site', { filename: 'photo.png', contentType: 'image/png', size: 3, actor: 'test' });
  expect(new URL(result.uploadUrl).host).toBe(`${account}.r2.cloudflarestorage.com`);
  expect(new URL(result.uploadUrl).pathname).toContain('/customer-private/private/media/abcdefghij/uploads/');
  const saved = await getStore().getDoc<Media>(`${paths.media('org', 'site')}/${result.mediaId}`);
  expect(saved?.storage?.provider).toBe('organization_r2');
  expect(saved?.cdn_url).toBe(`https://cms.example.com/api/sites/site/media/${result.mediaId}/content`);
  expect(JSON.stringify(saved)).not.toMatch(/X-Amz|synthetic-customer|secret_access_key/);
});

it('uses private draft storage before setup but never falls back after a customer disconnect', async () => {
  const before = await createMediaUpload('org', 'site', { filename: 'first.pdf', contentType: 'application/pdf', actor: 'test' });
  expect(before.storage).toBe('draft_r2');
  expect(new URL(before.uploadUrl).pathname).toContain('/private-drafts/');
  await connect();
  await getStore().updateDoc(connectionPath('org', 'cloudflare'), { status: 'disconnected', encrypted_credentials: null });
  await expect(createMediaUpload('org', 'site', { filename: 'second.pdf', contentType: 'application/pdf', actor: 'test' })).rejects.toThrow('original R2');
});

it('verifies immutable bytes and finalizes late grants at their recorded destination', async () => {
  const upload = await createMediaUpload('org', 'site', { filename: 'letter.pdf', contentType: 'application/pdf', size: 3, actor: 'test' });
  await connect();
  const sends: unknown[] = [];
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
    sends.push(command);
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => Buffer.from('abc') }, ContentLength: 3, ETag: 'etag-before-copy' };
    return {};
  });
  const result = await finalizeStoredMedia('org', 'site', upload.mediaId);
  expect(result.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const copied = sends.find(command => command instanceof CopyObjectCommand) as CopyObjectCommand;
  expect(copied.input.Bucket).toBe('private-drafts');
  expect(copied.input.Key).not.toBe(upload.key);
  expect(copied.input.CopySourceIfMatch).toBe('etag-before-copy');
  const saved = await getStore().getDoc<Media>(`${paths.media('org', 'site')}/${upload.mediaId}`);
  expect(saved?.storage?.state).toBe('ready');
  expect(saved?.storage?.provider).toBe('draft_r2');
  const read = await privateMediaReadUrl('org', 'site', upload.mediaId, 8);
  expect(new URL(read).searchParams.get('X-Amz-Expires')).toBe('8');
  await expect(privateMediaReadUrl('another-org', 'site', upload.mediaId)).rejects.toThrow('not ready');
});

it('does not publish or freeze corrupt uploads', async () => {
  await connect();
  const upload = await createMediaUpload('org', 'site', { filename: 'letter.pdf', contentType: 'application/pdf', actor: 'test' });
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({ Body: { transformToByteArray: async () => Buffer.from('abc') }, ContentLength: 3, ETag: 'etag' }));
  await expect(finalizeStoredMedia('org', 'site', upload.mediaId, '0'.repeat(64))).rejects.toThrow('does not match');
  expect(send).toHaveBeenCalledTimes(1);
  const saved = await getStore().getDoc<Media>(`${paths.media('org', 'site')}/${upload.mediaId}`);
  expect(saved?.storage?.state).toBe('uploading');
});
