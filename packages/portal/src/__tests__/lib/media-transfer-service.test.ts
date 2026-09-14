import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { customerTransferService, transferServiceStatus } from '../../lib/media/transfer-service';
const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: vi.fn(async () => api) }));
const account = 'a'.repeat(32);
let metadata: any;
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-secret-key-used-only-for-tests');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://staging.example.com');
  await connect();
  api.mockReset().mockImplementation(async (path, options) => {
    expect(path).toMatch(new RegExp(`^/accounts/${account}/`));
    if (path.endsWith('/lifecycle')) {
      if (options?.method === 'PUT') expect(options.body.rules).toEqual(expect.arrayContaining([{ id: 'existing-retention' }, expect.objectContaining({ conditions: { prefix: 'transfer-staging/' } })]));
      return { rules: [{ id: 'existing-retention' }] };
    }
    if (path.endsWith('/settings')) return null;
    if (options?.body instanceof FormData) { metadata = JSON.parse(options.body.get('metadata')); return {}; }
    if (path.endsWith('/workers/subdomain')) return { subdomain: 'synthetic-customer' };
    return {};
  });
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    expect(String(url)).toMatch(/^https:\/\/typeroll-media-[a-f0-9]{16}\.synthetic-customer\.workers\.dev\/health$/);
    const input = JSON.parse(options.body), secret = metadata.bindings.find((binding: any) => binding.name === 'TRANSFER_SECRET').text;
    const body = JSON.stringify({ protocol: 1, id: input.id, worker_sha: metadata.bindings.find((binding: any) => binding.name === 'WORKER_SHA').text });
    return new Response(body, { headers: { 'x-typeroll-signature': createHmac('sha256', secret).update(body).digest('hex') } });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function connect(credentials: object = { api_token: 'synthetic-token' }) {
  await getStore().setDoc(connectionPath('org', 'cloudflare'), { revision: 'connected', status: 'connected', media_ready: true,
    cloudflare: { account_id: account, bucket: 'private-originals', public_bucket: 'public-media' }, encrypted_credentials: sealCredentials('org', 'cloudflare', credentials) });
}
it('provisions only the organization account, preserves retention, reuses readiness, and isolates portal environments', async () => {
  const first = await customerTransferService('org');
  expect(await transferServiceStatus('org')).toMatchObject({ state: 'ready' });
  const calls = api.mock.calls.length;
  expect(await customerTransferService('org')).toEqual(first);
  expect(api).toHaveBeenCalledTimes(calls);
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://production.example.com');
  const second = await customerTransferService('org');
  expect(second.url).not.toBe(first.url);
  expect(second.secret).not.toBe(first.secret);
});
it('reports the missing Worker permission without replacing R2 keys or creating provider resources', async () => {
  await connect({ access_key_id: 'synthetic-r2', secret_access_key: 'synthetic-r2-secret', oauth: { scope: 'r2.write' } });
  await expect(customerTransferService('org')).rejects.toMatchObject({ code: 'media_transfer_approval_required' });
  expect(await transferServiceStatus('org')).toMatchObject({ state: 'error', code: 'media_transfer_approval_required' });
  expect(api).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects a disconnected organization without creating a Worker', async () => {
  await getStore().updateDoc(connectionPath('org', 'cloudflare'), { status: 'disconnected' });
  await expect(customerTransferService('org')).rejects.toMatchObject({ code: 'media_storage_unavailable' });
  expect(api).not.toHaveBeenCalled();
});

it('automatically retries setup after the user updates Cloudflare approval', async () => {
  await connect({ oauth: { scope: 'r2.write' } });
  await expect(customerTransferService('org')).rejects.toMatchObject({ code: 'media_transfer_approval_required' });
  await connect({ oauth: { scope: 'workers-scripts.read workers-scripts.write' } });
  await getStore().updateDoc(connectionPath('org', 'cloudflare'), { revision: 'new-approval' });
  expect(await transferServiceStatus('org')).toMatchObject({ state: 'automatic' });
  await customerTransferService('org');
  expect(await transferServiceStatus('org')).toMatchObject({ state: 'ready' });
});
