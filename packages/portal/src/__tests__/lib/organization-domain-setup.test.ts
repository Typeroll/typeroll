import { ProviderError } from '../../lib/publishing/providers.mjs';
import { beforeEach, expect, it, vi } from 'vitest';
import { listOrganizationPublishingZones, setupOrganizationDomains } from '../../lib/publishing/organization-domain-setup';
import { getOrganizationDomains, saveOrganizationDomains } from '../../lib/publishing/domain-config';
import { getConnection, connectionSummary, openCredentials } from '../../lib/publishing/connections';
import { cloudflareClient } from '../../lib/publishing/cloudflare-oauth';
import { preparePublicMediaDomains } from '../../lib/publishing/media-domain';
import { requestMediaMigration } from '../../lib/publishing/media-migration';
import { getOrganizationDomainStatus } from '../../lib/publishing/organization-domain-status';
vi.mock('../../lib/publishing/domain-config', async original => ({ ...await original<any>(), getOrganizationDomains: vi.fn(), saveOrganizationDomains: vi.fn() }));
vi.mock('../../lib/publishing/connections', async original => ({ ...await original<any>(), getConnection: vi.fn(), connectionSummary: vi.fn(), openCredentials: vi.fn() }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: vi.fn() }));
vi.mock('../../lib/publishing/media-domain', () => ({ preparePublicMediaDomains: vi.fn() }));
vi.mock('../../lib/publishing/media-migration', () => ({ requestMediaMigration: vi.fn() }));
vi.mock('../../lib/publishing/organization-domain-status', () => ({ getOrganizationDomainStatus: vi.fn() }));
const provider = vi.fn();
const zone = { id: 'a'.repeat(32), name: 'example.com', status: 'active', type: 'full', account: { id: 'account' } };
const input = { revision: 'original', zone_id: zone.id, media_subdomain: 'Media', sites_subdomain: 'sites' };
const settings = { revision: 'original', default_domain: null, sites_domain: null, media_host: null, dns_mode: 'external' as const, verified_at: null };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getOrganizationDomains).mockResolvedValue(settings);
  vi.mocked(getConnection).mockResolvedValue({ revision: 'connection', status: 'connected', cloudflare: { account_id: 'account', account_name: 'Example', public_bucket: 'public-media' } } as any);
  vi.mocked(connectionSummary).mockReturnValue({ media_ready: true } as any);
  vi.mocked(cloudflareClient).mockResolvedValue(provider as any);
  vi.mocked(getOrganizationDomainStatus).mockResolvedValue({ ...settings, revision: 'saved', domain_status: { state: 'pending' } } as any);
  provider.mockImplementation(async route => route === `/zones/${zone.id}` ? zone : route.includes('dns_records?') ? [] : null);
});
it('uses the connected account, normalizes labels, attaches R2 and queues migration after setup', async () => {
  const result = await setupOrganizationDomains('org', input);
  expect(saveOrganizationDomains).toHaveBeenCalledWith('org', { revision: 'original', sites_domain: 'sites.example.com', media_host: 'media.example.com', dns_mode: 'automatic' }, { queueMigration: false });
  expect(preparePublicMediaDomains).toHaveBeenCalledWith('org', expect.objectContaining({ account_id: 'account', public_bucket: 'public-media', media_host: 'media.example.com', site_prefix: '', entries: [] }));
  expect(requestMediaMigration).toHaveBeenCalledExactlyOnceWith('org');
  expect(result).toMatchObject({ revision: 'saved', setup_error: null, domain_status: { state: 'pending' } });
});
it.each([
  ['wrong account', { ...zone, account: { id: 'other' } }, 'domain_account_mismatch'],
  ['pending zone', { ...zone, status: 'pending' }, 'domain_zone_pending'],
  ['external DNS', { ...zone, type: 'partial' }, 'domain_external_dns'],
])('rejects %s before saving or attaching a hostname', async (_label, selected, code) => {
  provider.mockResolvedValue(selected);
  await expect(setupOrganizationDomains('org', input)).rejects.toMatchObject({ code });
  expect(saveOrganizationDomains).not.toHaveBeenCalled();
  expect(preparePublicMediaDomains).not.toHaveBeenCalled();
});
it.each(['A', 'AAAA', 'CNAME', 'NS'])('preserves an existing %s destination', async type => {
  provider.mockImplementation(async route => route === `/zones/${zone.id}` ? zone : route.includes('dns_records?') ? [{ type }] : null);
  await expect(setupOrganizationDomains('org', input)).rejects.toMatchObject({ code: 'media_domain_cutover_required' });
  expect(saveOrganizationDomains).not.toHaveBeenCalled();
});
it('reuses the same enabled R2 domain without treating its existing DNS as a conflict', async () => {
  provider.mockImplementation(async route => route === `/zones/${zone.id}` ? zone : { enabled: true, zoneId: zone.id });
  await setupOrganizationDomains('org', input);
  expect(provider.mock.calls.some(([route]) => route.includes('dns_records'))).toBe(false);
  expect(requestMediaMigration).toHaveBeenCalled();
});
it('rejects stale revisions and invalid labels before provider calls', async () => {
  await expect(setupOrganizationDomains('org', { ...input, revision: 'stale' })).rejects.toMatchObject({ code: 'domain_revision_conflict' });
  for (const label of ['media.example.com', 'https://media', '-media', '', 'm'.repeat(64)]) {
    await expect(setupOrganizationDomains('org', { ...input, media_subdomain: label })).rejects.toMatchObject({ code: 'invalid_subdomain' });
  }
  expect(provider).not.toHaveBeenCalled();
});
it('preserves published media aliases by rejecting replacement of a saved media host', async () => {
  vi.mocked(getOrganizationDomains).mockResolvedValue({ ...settings, media_host: 'old.example.com' });
  await expect(setupOrganizationDomains('org', input)).rejects.toMatchObject({ code: 'domain_migration_required' });
  expect(saveOrganizationDomains).not.toHaveBeenCalled();
});
it('returns the saved revision and a precise retry instruction after a denied write', async () => {
  vi.mocked(preparePublicMediaDomains).mockRejectedValue(new ProviderError('Cloudflare', 403));
  const result = await setupOrganizationDomains('org', input);
  expect(result.revision).toBe('saved');
  expect(result.setup_error).toContain('Allow domain access');
  expect(result.setup_error).not.toContain('provider detail');
  expect(requestMediaMigration).not.toHaveBeenCalled();
});
it('lists all pages but excludes domains belonging to other accounts', async () => {
  provider.mockImplementation(async route => route.includes('page=1&') ? Array.from({ length: 50 }, (_, i) => ({ ...zone, id: String(i) })) : [{ ...zone, id: 'last' }, { ...zone, account: { id: 'other' } }]);
  const result = await listOrganizationPublishingZones('org');
  expect(result.zones).toHaveLength(51);
  expect(result.zones.at(-1)?.id).toBe('last');
  expect(provider.mock.calls.every(([route]) => route.includes('account.id=account'))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('other');
});
it('explains denied Zone Read permission without provider details', async () => {
  provider.mockRejectedValue(new ProviderError('Cloudflare', 403));
  await expect(listOrganizationPublishingZones('org')).rejects.toMatchObject({ code: 'domain_access_required', message: expect.stringContaining('Allow domain access') });
});

it('requests additional approval only when the saved OAuth grant lacks domain permissions', async () => {
  vi.mocked(getConnection).mockResolvedValue({ revision: 'connection', status: 'connected', auth_method: 'oauth', encrypted_credentials: 'synthetic-envelope', cloudflare: { account_id: 'account', account_name: 'Example' } } as any);
  vi.mocked(openCredentials).mockReturnValue({ oauth: { scope: 'account-settings.read workers-r2.read' } });
  expect(await listOrganizationPublishingZones('org')).toMatchObject({ zones: [], domain_access: 'approval_required' });
  expect(provider).not.toHaveBeenCalled();
  vi.mocked(openCredentials).mockReturnValue({ oauth: { scope: 'zone.read dns.read dns.write' } });
  provider.mockResolvedValue([]);
  expect(await listOrganizationPublishingZones('org')).toMatchObject({ zones: [], domain_access: 'granted' });
  expect(provider).toHaveBeenCalledOnce();
});
