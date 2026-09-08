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
  const transfer = () => new WPMediaTransfer('org', 'site', getStore(), null);
  const execute = () => kind === 'url' ? transfer().ensureUrl(url, 'Photo') : transfer().transfer({ source_url: url, alt_text: 'Photo', mime_type: 'image/png', media_details: { width: 320, height: 240 } } as any);
  const result = await execute();
  expect(result.cdnUrl).toMatch(/^https:\/\/cms\.example\.com\/api\/sites\/site\/media\//);
  const record = await getStore().getDoc<Media>(`${paths.media('org', 'site')}/${result.mediaId}`);
  expect(record).toMatchObject({ storage: { provider: 'organization_r2', state: 'ready', bucket: 'org-private' }, source_aliases: [url], size_bytes: bytes.length });
  const put = vi.mocked(fetch).mock.calls.find(([, options]) => options?.method === 'PUT')!;
  expect(new URL(String(put[0])).pathname).toContain('/org-private/');
  expect(await execute()).toEqual(result);
  expect(await getStore().listDocs(paths.media('org', 'site'))).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('imports into private draft storage and permits preparation before publishing connections exist', async () => {
  const report = await runMigrationPreflight('org', 'site', 'main');
  expect(report.ready).toBe(true);
  expect(report.checks.find(check => check.id === 'hosting')?.detail).toContain('before connecting');
  await new WPMediaTransfer('org', 'site', getStore(), null).ensureUrl(url);
  expect((await getStore().listDocs<Media>(paths.media('org', 'site')))[0].storage).toMatchObject({ provider: 'draft_r2', state: 'ready' });
});

it('blocks a disconnected customer account before downloading and never hotlinks as fallback', async () => {
  await connect();
  await getStore().updateDoc(connectionPath('org', 'cloudflare'), { status: 'disconnected', encrypted_credentials: null });
  await expect(new WPMediaTransfer('org', 'site', getStore(), null).ensureUrl(url)).rejects.toMatchObject({ code: 'media_storage_unavailable' });
  expect(fetch).not.toHaveBeenCalled();
  const report = await runMigrationPreflight('org', 'site', 'main');
  expect(report.ready).toBe(false);
  expect(report.blockers[0].fix).toContain('Publishing → Media storage');
});

it('rejects an unavailable source instead of recording a successful customer import', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
  await expect(new WPMediaTransfer('org', 'site', getStore(), null).ensureUrl(url)).rejects.toThrow('HTTP 404');
  expect(await getStore().listDocs(paths.media('org', 'site'))).toHaveLength(0);
});

it('bounds streamed downloads even when Content-Length is missing', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(25 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close();
  } })));
  await expect(new WPMediaTransfer('org', 'site', getStore(), null).ensureUrl(url)).rejects.toThrow('25 MB');
  expect(await getStore().listDocs(paths.media('org', 'site'))).toHaveLength(0);
});
