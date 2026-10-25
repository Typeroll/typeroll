import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath } from '../../lib/publishing/connections';
import { getSiteDomains, saveSiteDomains } from '../../lib/publishing/domain-config';
import { onboardDomainZone } from '../../lib/publishing/domain-zone-onboarding';
const provider = vi.hoisted(() => vi.fn());
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => provider }));
vi.mock('node:dns/promises', () => ({ Resolver: class { async resolve() { return ['192.0.2.1']; } } }));
let records: any[], zone: any;
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); provider.mockReset(); records = [];
  const store = getStore();
  await store.setDoc(paths.site('org', 'site'), { name: 'Synthetic', publishing_mode: 'customer_git' });
  await store.setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', revision: 'connection', cloudflare: { account_id: 'account' } });
  const config = await getSiteDomains('org', 'site');
  await saveSiteDomains('org', 'site', { revision: config.revision, website_host: 'www.example.com', dns_mode: 'automatic' });
  zone = { id: 'zone', name: 'example.com', account: { id: 'account' }, status: 'pending', name_servers: ['ns1.example.net', 'ns2.example.net'] };
  provider.mockImplementation(async (route, options) => {
    if (route.startsWith('/zones?')) return [zone];
    if (route.endsWith('/scan/review')) return [
      { type: 'CNAME', name: 'mail._domainkey.example.com', content: 'dkim.mail.example.net', ttl: 300, proxied: true },
      { type: 'A', name: 'www.example.com', content: '192.0.2.1', ttl: 300, proxied: true },
    ];
    if (route.endsWith('/scan/trigger')) return {};
    if (route.includes('/dns_records?')) return structuredClone(records);
    if (route.endsWith('/dns_records') && options?.method === 'POST') { records.push({ id: String(records.length), ...options.body }); return records.at(-1); }
    throw new Error(`Unexpected route ${route}`);
  });
});
afterEach(() => vi.restoreAllMocks());
it('stages a DNS-only comparison, requires completeness confirmation and applies idempotently', async () => {
  const plan = await onboardDomainZone('org', 'site', { action: 'review_dns', zone_name: 'example.com' }) as any;
  expect(records).toEqual([]); expect(plan.records.every((record: any) => record.proxied === false)).toBe(true);
  expect(plan.comparisons[0].lookup).toBe('answered');
  const input = { action: 'apply_dns', zone_name: 'example.com', plan_revision: plan.revision };
  await expect(onboardDomainZone('org', 'site', input)).rejects.toMatchObject({ code: 'dns_inventory_review_required' });
  expect(await onboardDomainZone('org', 'site', { ...input, confirm_inventory: true })).toMatchObject({ state: 'applied', next_action: 'change_nameservers' });
  expect(records).toHaveLength(2); expect(records.every(record => !record.proxied)).toBe(true);
  await onboardDomainZone('org', 'site', { ...input, confirm_inventory: true }); expect(records).toHaveLength(2);
});
it('refuses an active zone and another organization’s site', async () => {
  await expect(onboardDomainZone('other', 'site', { action: 'scan_dns', zone_name: 'example.com' })).rejects.toMatchObject({ status: 404 });
  zone.status = 'active';
  await expect(onboardDomainZone('org', 'site', { action: 'scan_dns', zone_name: 'example.com' })).rejects.toMatchObject({ code: 'zone_already_active' });
});
it('does not overwrite DNS changed since the reviewed plan', async () => {
  const plan = await onboardDomainZone('org', 'site', { action: 'review_dns', zone_name: 'example.com' }) as any;
  records = [{ id: 'new', type: 'A', name: 'www.example.com', content: '192.0.2.2', proxied: false }];
  await expect(onboardDomainZone('org', 'site', { action: 'apply_dns', zone_name: 'example.com', plan_revision: plan.revision, confirm_inventory: true })).rejects.toMatchObject({ code: 'dns_revision_conflict' });
  expect(records.find(item => item.id === 'new').content).toBe('192.0.2.2');
});
it('binds a plan to its connection revision and domain', async () => {
  const plan = await onboardDomainZone('org', 'site', { action: 'review_dns', zone_name: 'example.com' }) as any;
  await getStore().updateDoc(connectionPath('org', 'cloudflare'), { revision: 'changed' });
  await expect(onboardDomainZone('org', 'site', { action: 'apply_dns', zone_name: 'example.com', plan_revision: plan.revision, confirm_inventory: true })).rejects.toMatchObject({ code: 'dns_plan_stale' });
  await expect(onboardDomainZone('org', 'site', { action: 'create_zone', zone_name: 'other.com' })).rejects.toMatchObject({ code: 'zone_host_mismatch' });
});
