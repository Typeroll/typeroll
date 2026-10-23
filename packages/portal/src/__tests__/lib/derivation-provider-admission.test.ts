import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { stableDigest } from '../../lib/publishing/build-derivation';
const transport = vi.hoisted(() => ({ sign: vi.fn(() => 'synthetic-proof'), request: vi.fn() }));
vi.mock('../../lib/extensions/auth', () => ({ signInstallationAssertion: transport.sign }));
vi.mock('../../lib/extensions/admin-request', async original => ({ ...await original<object>(), requestApprovedAdmin: transport.request }));
import { derivationProvidersFor } from '../../lib/publishing/derivation-providers';
const runtime = { installation_id: 'installed', extension_id: 'org.example.compute', version: '1.0.0', public_config: { map: 'frozen' } };
const installationPath = paths.extensionInstallation('org', 'site', 'installed');
const releasePath = paths.extensionVersion('developer', runtime.extension_id, runtime.version);
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  await getStore().setDoc(installationPath, { id: 'installed', developer_org_id: 'developer', status: 'enabled', extension_id: runtime.extension_id,
    version: 'newer', granted_scopes: ['content:read'], config: { map: 'live-changed', secret: 'PRIVATE-SENTINEL' } });
  await getStore().setDoc(releasePath, { status: 'published', manifest: { id: runtime.extension_id, version: '1.0.0', api: { base_url: 'https://app.example/v1' },
    build_derivation: { input_format: 'frozen_publication_v1', path: '/derive', sources: ['example.records'], required: true } } });
  transport.request.mockResolvedValue({ status: 200, data: {} });
});
const providers = () => derivationProvidersFor('org', 'site', { installations: [runtime as any] });
it('uses the frozen release and config with bounded signed transport, not mutable installation config', async () => {
  const [provider] = await providers();
  expect(provider.version).toBe('1.0.0'); expect(provider.config).toEqual({ map: 'frozen' });
  const content = { version_id: 'main', pages: [], content_types: [] };
  const input = { org_id: 'org', site_id: 'site', version_id: 'main', provider_version: '1.0.0', content, content_digest: stableDigest(content),
    config: provider.config, config_digest: stableDigest(provider.config) };
  await provider.request(input);
  expect(transport.sign).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'build_derivation', version: '1.0.0' }));
  expect(transport.request.mock.calls[0][0].href).toBe('https://app.example/v1/derive');
  expect(transport.request.mock.calls[0][4]).toEqual({ requestBytes: 8 * 1024 * 1024, responseBytes: 16 * 1024 * 1024 });
  expect(JSON.stringify(transport.request.mock.calls)).not.toContain('PRIVATE-SENTINEL');
  await expect(provider.request({ ...input, content_digest: 'stale' })).rejects.toThrow('inconsistent');
});
it('refuses revoked, disabled, unknown and scope-reduced installations before calling a provider', async () => {
  await getStore().updateDoc(installationPath, { status: 'disabled' });
  await expect(providers()).rejects.toThrow('Installation changed');
  await getStore().updateDoc(installationPath, { status: 'enabled', granted_scopes: [] });
  await expect(providers()).rejects.toThrow('content:read');
  await getStore().updateDoc(installationPath, { granted_scopes: ['content:read'] });
  await getStore().updateDoc(releasePath, { status: 'revoked' });
  await expect(providers()).rejects.toThrow('no longer available');
  expect(transport.request).not.toHaveBeenCalled();
});
