import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getSiteDomains, saveSiteDomains } from '../../lib/publishing/domain-config';
const mocks = vi.hoisted(() => ({ provider: vi.fn(), ready: vi.fn(), launch: vi.fn() }));
vi.mock('node:dns/promises', () => ({ Resolver: class { async resolveNs() { return ['ns2.example.net', 'ns1.example.net']; } } }));
vi.mock('../../lib/publishing/host-checks', async original => ({ ...await original<object>(), siteZoneSources: async () => [{ account: 'hosting', accountId: 'account', provider: mocks.provider }] }));
vi.mock('../../lib/publishing/readiness', () => ({ publishingReadiness: mocks.ready }));
vi.mock('../../lib/publishing/publication-version', () => ({ resolvePublicationVersion: async () => ({ redirects: [], settings: {} }) }));
vi.mock('../../lib/publishing/cloudflare-capabilities', () => ({ cloudflarePermissionReport: async () => ({ capabilities: [] }) }));
vi.mock('../../lib/migration-launch-report', () => ({ buildMigrationLaunchReport: mocks.launch }));
import { readDomainGuide } from '../../lib/publishing/domain-guide';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  mocks.ready.mockResolvedValue({ ready: true, required: [] });
  mocks.launch.mockResolvedValue({ launch_ready: false, issues: [{ detail: 'Verify the remaining legacy URLs.' }] });
  mocks.provider.mockImplementation(async route => route.startsWith('/zones?') ? [{ id: 'zone', name: 'example.com', status: 'active', account: { id: 'account' }, name_servers: ['ns1.example.net', 'ns2.example.net'] }] : [{ certificate_status: 'active', hosts: ['example.com', '*.example.com'] }]);
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Site', publishing_mode: 'customer_git' });
  const config = await getSiteDomains('org', 'site');
  await saveSiteDomains('org', 'site', { revision: config.revision, website_host: 'example.com', dns_mode: 'automatic' });
});
afterEach(() => vi.restoreAllMocks());
it('reports observed prerequisites without provider writes and directs an unpublished site to first publication', async () => {
  const guide = await readDomainGuide('org', 'site');
  expect(guide).toMatchObject({ traffic_live: false, next_action: 'publish_first', current_phase: 'Ready to prepare' });
  expect(guide.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'nameservers:example.com', status: 'ready' }),
    expect.objectContaining({ id: 'certificate:example.com', status: 'ready' }),
    expect.objectContaining({ id: 'redirect_capacity', status: 'ready' }),
  ]));
  expect(mocks.provider.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it('shows existing migration launch evidence separately from publishing connection readiness', async () => {
  await getStore().setDoc(paths.migrationUrl('org', 'site', 'url'), { source_url: 'https://old.example.com/' });
  await getStore().setDoc(`${paths.site('org', 'site')}/publishing_targets/main`, { last_publication: { publication_id: 'old' } });
  const guide = await readDomainGuide('org', 'site');
  expect(guide.next_action).toBe('prepare');
  expect(guide.checks.find(check => check.id === 'launch_ready')).toMatchObject({ status: 'action_required', message: 'Verify the remaining legacy URLs.' });
});
it('does not mistake a failed publishing readiness read for a redirect-capacity failure', async () => {
  mocks.ready.mockRejectedValue(new Error('Reconnect the hosting account.'));
  const guide = await readDomainGuide('org', 'site');
  expect(guide.can_prepare).toBe(false);
  expect(guide.checks.find(check => check.id === 'publishing_ready')).toMatchObject({ status: 'action_required', message: 'Reconnect the hosting account.' });
  expect(guide.checks.find(check => check.id === 'redirect_capacity')?.status).toBe('ready');
});
