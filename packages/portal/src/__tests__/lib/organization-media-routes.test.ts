import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { APIRoute } from 'astro';
import { paths, type Media, type Site } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { createApiKey } from '../../lib/api-keys';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { getSiteDomains } from '../../lib/publishing/domain-config';

vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  requireSiteAccess: vi.fn(async () => ({ ok: true, value: {
    session: { userId: 'editor', orgId: 'guest' }, owner_org_id: 'owner', permission: 'write',
    site: await getStore().getDoc(paths.site('owner', 'site')),
  } })),
}));
const account = 'a'.repeat(32);
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.com');
  vi.stubEnv('R2_ACCOUNT_ID', 'b'.repeat(32));
  vi.stubEnv('R2_BUCKET', 'legacy-public');
  vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://legacy.example.com');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'synthetic-legacy-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'synthetic-legacy-secret');
  await getStore().setDoc(connectionPath('owner', 'cloudflare'), {
    revision: 'connected', status: 'connected', media_ready: true,
    cloudflare: { account_id: account, bucket: 'owner-private', public_bucket: 'owner-public' },
    encrypted_credentials: sealCredentials('owner', 'cloudflare', { access_key_id: 'synthetic-owner-key', secret_access_key: 'synthetic-owner-secret' }),
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function upload(surface: 'cookie' | 'api') {
  const api = surface === 'api';
  const { token } = await createApiKey({ orgId: 'owner', siteId: 'site', name: 'test', createdBy: 'test' });
  const handler = api
    ? (await import('../../pages/api/v1/sites/[siteId]/media/upload-url')).POST
    : (await import('../../pages/api/sites/[siteId]/media/upload-url')).POST;
  return await handler({ request: new Request('https://cms.example.com/api/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename: 'photo.png', [api ? 'content_type' : 'contentType']: 'image/png', size: 3 }),
  }), params: { siteId: 'site' }, cookies: {}, locals: {} } as unknown as Parameters<APIRoute>[0]) as Response;
}

it.each(['cookie', 'api'] as const)('routes unpublished %s uploads to the owner organization and changes the next builder', async surface => {
  await getStore().setDoc(paths.site('owner', 'site'), { name: 'Legacy', media_id: 'abcdefghij', publishing_mode: 'managed', domain: 'www.example.com', domain_status: 'live' });
  const response = await upload(surface);
  expect(response.status).toBe(200);
  const body = await response.json();
  const url = new URL(body.upload_url ?? body.uploadUrl);
  expect(url.hostname).toBe(`${account}.r2.cloudflarestorage.com`);
  expect(url.pathname).toContain('/owner-private/');
  expect(body.storage).toBe('organization_r2');
  expect(new URL(body.cdn_url ?? body.cdnUrl).hostname).toBe('cms.example.com');
  const site = await getStore().getDoc<Site>(paths.site('owner', 'site'));
  expect(site).toMatchObject({ publishing_mode: 'customer_git', domain: 'www.example.com', domain_status: 'live' });
  expect((await getSiteDomains('owner', 'site')).desired.website_host).toBe('www.example.com');
  const saved = await getStore().listDocs<Media>(paths.media('owner', 'site'));
  expect(saved).toHaveLength(1);
  expect(saved[0].storage?.provider).toBe('organization_r2');
  expect(await getStore().listDocs(paths.media('guest', 'site'))).toHaveLength(0);
});

it.each(['cookie', 'api'] as const)('does not fall back or adopt the site when the organization disconnected (%s)', async surface => {
  await getStore().setDoc(paths.site('owner', 'site'), { name: 'Legacy', media_id: 'abcdefghij' });
  await getStore().updateDoc(connectionPath('owner', 'cloudflare'), { status: 'disconnected', encrypted_credentials: null });
  const response = await upload(surface);
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('media_storage_unavailable');
  expect(await getStore().listDocs(paths.media('owner', 'site'))).toHaveLength(0);
  expect((await getStore().getDoc<Site>(paths.site('owner', 'site')))?.publishing_mode).toBeUndefined();
});

it('reports unavailable organization storage for legacy sites before upload', async () => {
  await getStore().setDoc(paths.site('owner', 'site'), { name: 'Legacy', media_id: 'abcdefghij' });
  await getStore().updateDoc(connectionPath('owner', 'cloudflare'), { status: 'disconnected', encrypted_credentials: null });
  const { GET } = await import('../../pages/api/sites/[siteId]/media/upload-status');
  const response = await GET({ params: { siteId: 'site' }, cookies: {}, locals: {} } as unknown as Parameters<APIRoute>[0]) as Response;
  expect(await response.json()).toMatchObject({ enabled: false, settings_url: '/app/settings/publishing' });
});


it.each(['cookie', 'api'] as const)('finalizes a legacy grant after the site adopted customer publishing (%s)', async surface => {
  await getStore().setDoc(paths.site('owner', 'site'), { name: 'Adopted', media_id: 'abcdefghij', publishing_mode: 'customer_git' });
  await getStore().setDoc(`${paths.media('owner', 'site')}/late`, { filename: 'letter.pdf', mime_type: 'application/pdf', r2_key: 'legacy/letter.pdf', cdn_url: 'https://legacy.example.com/legacy/letter.pdf' });
  const sends: unknown[] = [];
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
    sends.push(command);
    return command instanceof GetObjectCommand ? { Body: { transformToByteArray: async () => Buffer.from('abc') }, ContentLength: 3 } : {};
  });
  const { token } = await createApiKey({ orgId: 'owner', siteId: 'site', name: 'test', createdBy: 'test' });
  const handler = surface === 'api'
    ? (await import('../../pages/api/v1/sites/[siteId]/media/[mediaId]/finalize')).POST
    : (await import('../../pages/api/sites/[siteId]/media/[mediaId]/finalize')).POST;
  const response = await handler({ request: new Request('https://cms.example.com/api/finalize', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}',
  }), params: { siteId: 'site', mediaId: 'late' }, cookies: {}, locals: {} } as unknown as Parameters<APIRoute>[0]) as Response;
  expect(response.status).toBe(200);
  expect((await response.json()).result.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect((sends.find(command => command instanceof GetObjectCommand) as GetObjectCommand).input.Bucket).toBe('legacy-public');
});

it.each(['cookie', 'api'] as const)('keeps existing managed hosting and media during %s uploads until explicit migration', async surface => {
  await getStore().setDoc(paths.site('owner', 'site'), { name: 'Existing', media_id: 'abcdefghij', publishing_mode: 'managed', hosting_config: { pages_project: 'existing-live-project' } });
  const response = await upload(surface);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(new URL(body.cdn_url ?? body.cdnUrl).hostname).toBe('legacy.example.com');
  expect((await getStore().getDoc<Site>(paths.site('owner', 'site')))?.publishing_mode).toBe('managed');
  const media = await getStore().listDocs<Media>(paths.media('owner', 'site'));
  expect(media).toHaveLength(1); expect(media[0].storage).toBeUndefined();
  expect(await getStore().listDocs(paths.media('guest', 'site'))).toHaveLength(0);
});
