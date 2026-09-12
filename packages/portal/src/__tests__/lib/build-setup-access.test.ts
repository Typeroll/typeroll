import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { configureBuildEngine } from '../../lib/builds/setup';
import { readBuildEngine } from '../../lib/builds/cloudflare';
import { readEngineConfiguration } from '../../lib/builds/state';
import { prepareBuildRetention } from '../../lib/builds/storage';
import { ProviderError } from '../../lib/publishing/providers.mjs';
vi.mock('../../lib/builds/storage', () => ({ prepareBuildRetention: vi.fn() }));
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.invalid');
  vi.mocked(prepareBuildRetention).mockReset();
  await getStore().setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', revision: 'cf', media_ready: true,
    cloudflare: { account_id: 'a'.repeat(32), account_name: 'Build account' }, encrypted_credentials: sealCredentials('org', 'cloudflare', { api_token: 'synthetic-token' }) });
  await getStore().setDoc(connectionPath('org', 'github'), { status: 'connected', revision: 'gh', github: { owner: 'Example', installation_id: '123' } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each([401, 403])('stops setup before mutations and offers approval when build access is denied with %s', async status => {
  const request = vi.fn(async () => Response.json({ success: false, errors: [{ code: 10000, message: 'do-not-expose-provider-payload' }] }, { status }));
  vi.stubGlobal('fetch', request);
  const result = await configureBuildEngine('org', { action: 'setup', revision: 'initial' });
  expect(result).toMatchObject({ state: 'approval_required', account_name: 'Build account', issue: { code: 'build_permission_required', http_status: status, provider_codes: [10000] } });
  expect(result.issue?.message).toContain('Click Approve build permissions');
  expect(JSON.stringify(result)).not.toContain('do-not-expose');
  expect(request).toHaveBeenCalledTimes(2);
  for (const [, options] of request.mock.calls as unknown as [string, RequestInit][]) expect(options.method).toBe('GET');
  expect(prepareBuildRetention).not.toHaveBeenCalled();
  expect(await readEngineConfiguration('org')).toBeNull();
  expect(await readBuildEngine('org')).toMatchObject(result);
});
it('does not start resource setup when the provider is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false }, { status: 503 })));
  expect(await configureBuildEngine('org', { action: 'setup', revision: 'initial' })).toMatchObject({ state: 'error', issue: { code: 'build_provider_unavailable', http_status: 503 } });
  expect(prepareBuildRetention).not.toHaveBeenCalled();
  expect(await readEngineConfiguration('org')).toBeNull();
});
it('rejects stale revisions before contacting the provider', async () => {
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  await expect(configureBuildEngine('org', { action: 'setup', revision: 'stale' })).rejects.toMatchObject({ status: 409 });
  expect(request).not.toHaveBeenCalled(); expect(prepareBuildRetention).not.toHaveBeenCalled();
});
it('identifies denied Worker writes after read access passes and releases setup for retry', async () => {
  const request = vi.fn(async (_url: unknown, options?: RequestInit) => options?.method === 'PUT'
    ? Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 })
    : Response.json({ success: true, result: [] }));
  vi.stubGlobal('fetch', request);
  const result = await configureBuildEngine('org', { action: 'setup', revision: 'initial' });
  expect(prepareBuildRetention).toHaveBeenCalledOnce();
  expect(request.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true);
  expect(result).toMatchObject({ state: 'approval_required', issue: { code: 'build_permission_required', http_status: 403 } });
  expect(result.issue?.message).toContain('denied changes to Workers Scripts');
  expect(await readEngineConfiguration('org')).toMatchObject({ status: 'disabled', setup_lease_until: 0 });
});
it('identifies storage failure separately instead of asking for unrelated build permissions', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result: [] })));
  vi.mocked(prepareBuildRetention).mockRejectedValue(new ProviderError('Cloudflare', 403, [10000]));
  const result = await configureBuildEngine('org', { action: 'setup', revision: 'initial' });
  expect(result).toMatchObject({ state: 'error', issue: { code: 'build_setup_failed', http_status: 403 } });
  expect(result.issue?.message).toContain('R2 build storage');
  expect(result.issue?.message).not.toContain('Approve build permissions');
  expect(await readEngineConfiguration('org')).toMatchObject({ status: 'disabled', setup_lease_until: 0 });
});
