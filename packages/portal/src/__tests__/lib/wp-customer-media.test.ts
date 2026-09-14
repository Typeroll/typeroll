vi.mock('../../lib/media/remote-transfer', () => ({ remoteTransfersEnabled: vi.fn(async () => true), copyWithTransferService: vi.fn() }));
import { copyWithTransferService } from '../../lib/media/remote-transfer';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { WPMediaTransfer } from '../../lib/wp/media';
import { runMigrationPreflight } from '../../lib/migration-preflight';

const bytes = Buffer.from('synthetic-image');
const url = 'https://wordpress.example.com/uploads/photo.png';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.mocked(copyWithTransferService).mockReset().mockResolvedValue({ protocol: 1, id: 'synthetic-request', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, etag: '"synthetic-etag"' });
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.com');
  vi.stubEnv('R2_ACCOUNT_ID', 'b'.repeat(32));
  vi.stubEnv('R2_PRIVATE_BUCKET', 'draft-private');
  vi.stubEnv('R2_BUCKET', 'legacy-public');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'synthetic-draft-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'synthetic-draft-secret');
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Synthetic', media_id: 'abcdefghij', publishing_mode: 'customer_git' });
  await getStore().setDoc(paths.version('org', 'site', 'main'), { kind: 'main' });
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => command instanceof GetObjectCommand
    ? { Body: { transformToByteArray: async () => bytes }, ContentLength: bytes.length, ETag: 'synthetic-etag' } : {});
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => options?.method === 'PUT'
    ? new Response(null, { status: 200 }) : new Response(bytes, { headers: { 'content-type': 'image/png' } })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function connect() {
  await getStore().setDoc(connectionPath('org', 'cloudflare'), {
    revision: 'connected', status: 'connected', media_ready: true,
    cloudflare: { account_id: 'a'.repeat(32), bucket: 'org-private', public_bucket: 'org-public' },
    encrypted_credentials: sealCredentials('org', 'cloudflare', { access_key_id: 'synthetic-owner-key', secret_access_key: 'synthetic-owner-secret' }),
  });
}

it.each(['url', 'item'] as const)('imports WordPress %s media directly to customer storage and reuses verified imports', async kind => {
  await connect();
  const transfer = () => new WPMediaTransfer('org', 'site', getStore());
  const execute = () => kind === 'url' ? transfer().ensureUrl(url, 'Photo') : transfer().transfer({ source_url: url, alt_text: 'Photo', mime_type: 'image/png', media_details: { width: 320, height: 240 } } as any);
  const result = await execute();
  expect(result.cdnUrl).toMatch(/^https:\/\/cms\.example\.com\/api\/sites\/site\/media\//);
  const record = await getStore().getDoc<Media>(`${paths.media('org', 'site')}/${result.mediaId}`);
  expect(record).toMatchObject({ storage: { provider: 'organization_r2', state: 'ready', bucket: 'org-private' }, source_aliases: [url], size_bytes: bytes.length });
  expect(copyWithTransferService).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org', bucket: 'org-private', sourceUrl: url }));
  expect(await execute()).toEqual(result);
  expect(await getStore().listDocs(paths.media('org', 'site'))).toHaveLength(1);
  expect(copyWithTransferService).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.mocked(S3Client.prototype.send).mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(false);
});

it.each(['url', 'item'] as const)('blocks %s imports before connecting storage, even with configured draft storage', async kind => {
  const transfer = new WPMediaTransfer('org', 'site', getStore());
  await expect(kind === 'url' ? transfer.ensureUrl(url) : transfer.transfer({ source_url: url } as any)).rejects.toMatchObject({ status: 409, code: 'import_storage_required' });
  expect((await runMigrationPreflight('org', 'site', 'main')).ready).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(copyWithTransferService).not.toHaveBeenCalled();
  expect(await getStore().listDocs(paths.media('org', 'site'))).toHaveLength(0);
});

it('checks readiness before reusing cached successful imports after a disconnect', async () => {
  await connect();
  const transfer = new WPMediaTransfer('org', 'site', getStore());
  await transfer.ensureUrl(url);
  await getStore().updateDoc(connectionPath('org', 'cloudflare'), { status: 'disconnected', encrypted_credentials: null });
  await expect(transfer.ensureUrl(url)).rejects.toMatchObject({ code: 'import_storage_required' });
  expect(copyWithTransferService).toHaveBeenCalledTimes(1);
});

it('retains pending identity after transfer failure and retries without duplicate media', async () => {
  await connect();
  vi.mocked(copyWithTransferService).mockRejectedValueOnce(new Error('Source unavailable'));
  const transfer = () => new WPMediaTransfer('org', 'site', getStore());
  await expect(transfer().ensureUrl(url)).rejects.toThrow('Source unavailable');
  const pending = await getStore().listDocs<Media>(paths.media('org', 'site'));
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ import_pending: true, storage: { state: 'uploading' } });
  const result = await transfer().ensureUrl(url);
  expect(result.mediaId).toBe(pending[0].id);
  expect(await getStore().listDocs(paths.media('org', 'site'))).toHaveLength(1);
  expect(await getStore().getDoc(`${paths.media('org', 'site')}/${result.mediaId}`)).toMatchObject({ import_pending: false, storage: { state: 'ready' } });
});
