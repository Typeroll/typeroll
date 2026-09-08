import { beforeEach, expect, it, vi } from 'vitest';
import { getOrganizationDomainStatus } from '../../lib/publishing/organization-domain-status';
import { canReplaceOrganizationMediaHost, getOrganizationDomains } from '../../lib/publishing/domain-config';
import { getConnection, connectionSummary } from '../../lib/publishing/connections';
import { cloudflareClient } from '../../lib/publishing/cloudflare-oauth';

vi.mock('../../lib/publishing/domain-config', async original => ({ ...await original<any>(), canReplaceOrganizationMediaHost: vi.fn(), getOrganizationDomains: vi.fn() }));
vi.mock('../../lib/publishing/connections', async original => ({ ...await original<any>(), getConnection: vi.fn(), connectionSummary: vi.fn() }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: vi.fn() }));
const provider = vi.fn();
const settings = { revision: 'settings', default_domain: null, sites_domain: 'sites.example.com', media_host: 'media.example.com', dns_mode: 'external' as const, verified_at: null };
const connection = { revision: 'connection', status: 'connected' as const, cloudflare: { account_id: 'account', account_name: 'Example', bucket: 'private-originals', public_bucket: 'public-media', endpoint: 'https://storage.example.com' } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(canReplaceOrganizationMediaHost).mockResolvedValue(true);
  vi.mocked(getOrganizationDomains).mockResolvedValue(settings);
  vi.mocked(getConnection).mockResolvedValue(connection);
  vi.mocked(connectionSummary).mockReturnValue({ media_ready: true } as ReturnType<typeof connectionSummary>);
  vi.mocked(cloudflareClient).mockResolvedValue(provider as any);
  provider.mockImplementation(async route => route.startsWith('/zones?') ? [] : null);
});
it('returns missing setup and external DNS instructions for the public bucket without writing DNS', async () => {
  const result = await getOrganizationDomainStatus('org');
  expect(result.sites_domain).toBe('sites.example.com');
  expect(result.domain_status).toMatchObject({ state: 'setup_required', zone_check: 'not_found', public_bucket: 'public-media' });
  const help = JSON.stringify(result.domain_status.steps);
  expect(help).toContain('Business or Enterprise');
  expect(help).toContain('Keep your current nameservers');
  expect(help).toContain('Custom Domains → Add, enter media.example.com');
  expect(help).not.toContain('private-originals');
  for (const [, options] of provider.mock.calls) expect(options?.method ?? 'GET').toBe('GET');
});
it('does not treat an enabled hostname with a pending certificate as active', async () => {
  provider.mockImplementation(async route => route.startsWith('/zones?') ? [] : { enabled: true, status: { ownership: 'active', ssl: 'pending' } });
  expect((await getOrganizationDomainStatus('org')).domain_status).toMatchObject({ state: 'pending', ownership: 'active', certificate: 'pending' });
});
it('can verify an externally managed R2 domain without Zone Read permission', async () => {
  provider.mockImplementation(async route => {
    if (route.startsWith('/zones?')) throw Object.assign(new Error('synthetic-sensitive-body'), { status: 403 });
    return { enabled: true, status: { ownership: 'active', ssl: 'active' } };
  });
  const result = await getOrganizationDomainStatus('org');
  expect(result.domain_status).toMatchObject({ state: 'active', zone_check: 'unavailable' });
  expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-body');
});
it('distinguishes denied provider access from a missing domain', async () => {
  provider.mockRejectedValue(Object.assign(new Error('synthetic-provider-secret'), { status: 403 }));
  const result = await getOrganizationDomainStatus('org');
  expect(result.domain_status.state).toBe('check_failed');
  expect(result.domain_status.message).toContain('denied access');
  expect(JSON.stringify(result)).not.toContain('synthetic-provider-secret');
});
it('returns partial setup guidance without suggesting a nameserver move', async () => {
  provider.mockImplementation(async route => route.startsWith('/zones?') ? [{ name: 'example.com', account: { id: 'account' }, type: 'partial', status: 'active' }] : null);
  const result = await getOrganizationDomainStatus('org');
  expect(result.domain_status.zone).toMatchObject({ name: 'example.com', type: 'partial', status: 'active' });
  expect(result.domain_status.steps.map(step => step.title)).not.toContain('If DNS is hosted by Cloudflare');
});
it('does not contact Cloudflare until storage and a media hostname are configured', async () => {
  vi.mocked(getOrganizationDomains).mockResolvedValue({ ...settings, media_host: null });
  expect((await getOrganizationDomainStatus('org')).domain_status.state).toBe('not_configured');
  vi.mocked(getOrganizationDomains).mockResolvedValue(settings);
  vi.mocked(connectionSummary).mockReturnValue({ media_ready: false } as ReturnType<typeof connectionSummary>);
  expect((await getOrganizationDomainStatus('org')).domain_status.state).toBe('storage_required');
  expect(provider).not.toHaveBeenCalled();
});
it('ignores a same-name zone in another Cloudflare account', async () => {
  provider.mockImplementation(async route => route.startsWith('/zones?') ? [{ name: 'example.com', account: { id: 'other-account' }, type: 'full', status: 'active' }] : null);
  expect((await getOrganizationDomainStatus('org')).domain_status.zone_check).toBe('not_found');
});

it('exposes the same replacement decision as the write API', async () => {
  expect((await getOrganizationDomainStatus('org')).media_host_change_allowed).toBe(true);
  vi.mocked(canReplaceOrganizationMediaHost).mockResolvedValue(false);
  expect((await getOrganizationDomainStatus('org')).media_host_change_allowed).toBe(false);
  expect(canReplaceOrganizationMediaHost).toHaveBeenCalledWith('org', settings);
});
