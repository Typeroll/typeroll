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
// Public host observations never reach the network; by default they fail (inconclusive).
const network = vi.hoisted(() => ({ respond: (() => { throw new TypeError('no network in tests'); }) as (url: URL, init?: RequestInit) => Response }));
vi.mock('../../lib/net/safe-fetch', async load => ({ ...await load<object>(), createSafeFetch: () => (async (input: string | URL, init?: RequestInit) => network.respond(new URL(String(input)), init)) as typeof fetch }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => mocks.provider }));
vi.mock('../../lib/publishing/hosting-dns', () => ({ hostingDns: async () => ({ provider: mocks.provider, accountId: 'account', groupId: 'default' }) }));
import { domainGuideAction, readDomainGuide } from '../../lib/publishing/domain-guide';
import { ProviderError } from '../../lib/publishing/providers.mjs';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  network.respond = () => { throw new TypeError('no network in tests'); };
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
  expect(guide).toMatchObject({ traffic_live: false, next_action: 'publish_first', current_phase: 'Ready to publish for the new domain' });
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
it('reports the latest main publication failure instead of offering an older DNS approval', async () => {
  const {siteDomainConfigPath}=await import('../../lib/publishing/domain-config');
  const config=await getSiteDomains('org','site');
  await getStore().updateDoc(siteDomainConfigPath('org','site'),{state:'ready_to_switch',candidate:{id:'older',job_id:'old-job'},published:{hosts:config.desired,dns_mode:'automatic',publication_id:'latest'}});
  await getStore().setDoc(paths.deploy('org','site','old-job'),{status:'running',phase:'awaiting domain cutover approval'});
  await getStore().setDoc(paths.deploy('org','site','latest-job'),{status:'failed',phase:'failed',error:'Certificate setup failed.'});
  await getStore().setDoc(`${paths.site('org','site')}/publishing_targets/main`,{last_publication:{publication_id:'latest',snapshot_job_id:'latest-job'}});
  const guide=await readDomainGuide('org','site');
  expect(guide).toMatchObject({published_main:false,next_action:'prepare'});
  expect(guide.checks.find(check=>check.id==='candidate')).toMatchObject({status:'action_required',message:'Certificate setup failed.'});
});
it('shows verification failure for the replaced main artifact even before its public verification receipt', async () => {
  const {siteDomainConfigPath}=await import('../../lib/publishing/domain-config');
  const config=await getSiteDomains('org','site');
  await getStore().updateDoc(siteDomainConfigPath('org','site'),{state:'preparing',candidate:{id:'older',job_id:'old-job'},published:{hosts:config.desired,dns_mode:'automatic',publication_id:'latest',job_id:'latest-job'}});
  await getStore().setDoc(paths.deploy('org','site','old-job'),{status:'running',phase:'awaiting domain cutover approval'});
  await getStore().setDoc(paths.deploy('org','site','latest-job'),{status:'failed',phase:'failed',error:'Public verification timed out.'});
  await getStore().setDoc(`${paths.site('org','site')}/publishing_targets/main`,{last_publication:{publication_id:'older',snapshot_job_id:'old-job'}});
  const guide=await readDomainGuide('org','site');
  expect(guide).toMatchObject({published_main:false,next_action:'prepare'});
  expect(guide.checks.find(check=>check.id==='candidate')).toMatchObject({status:'action_required',message:'Public verification timed out.'});
});
it('falls back to the zone activation window when the connection may not read certificates', async () => {
  const zone = (activated: string) => ({ id: 'zone', name: 'example.com', status: 'active', account: { id: 'account' }, name_servers: ['ns1.example.net', 'ns2.example.net'], activated_on: activated });
  let activated = new Date(Date.now() - 48 * 3_600_000).toISOString();
  mocks.provider.mockImplementation(async route => { if (route.startsWith('/zones?')) return [zone(activated)]; throw new ProviderError('Cloudflare', 403, [10000]); });
  const certificate = async () => (await readDomainGuide('org', 'site')).checks.find(check => check.id === 'certificate:example.com');
  expect(await certificate()).toMatchObject({ status: 'ready', details: { source: 'zone_activation' } });
  activated = new Date(Date.now() - 3_600_000).toISOString();
  expect(await certificate()).toMatchObject({ status: 'waiting' });
  mocks.provider.mockImplementation(async route => { if (route.startsWith('/zones?')) return [zone(activated)]; throw new ProviderError('Cloudflare', 502); });
  expect(await certificate()).toMatchObject({ status: 'waiting', message: expect.stringContaining('Retry the check') });
});

it('does not read as a healthy live domain while another host serves it', async () => {
  const {siteDomainConfigPath}=await import('../../lib/publishing/domain-config');
  const config=await getSiteDomains('org','site');
  const issue={code:'domain_served_by_other_host',host:'example.com',remedy:"Remove the domain from the previous host's dashboard (for example MyKinsta → Domains); its Cloudflare for SaaS hostname outranks your own DNS.",message:'example.com is not served by Typeroll.'};
  await getStore().updateDoc(siteDomainConfigPath('org','site'),{state:'live',active:config.desired,published:{hosts:config.desired,dns_mode:'automatic',publication_id:'pub',job_id:'job'},
    serving_check:{status:'other_host',publication_id:'pub',website_host:'example.com',job_id:'job',live_at:new Date().toISOString(),checked_at:new Date().toISOString(),next_check_at:null,hosts:[],
      observed:{host:'example.com',publication:null,http_status:200,provider_hint:{provider:'kinsta',name:'Kinsta',evidence:'x-kinsta-cache: HIT',cloudflare_for_saas:true}},issue}});
  await getStore().setDoc(paths.deploy('org','site','job'),{status:'succeeded',phase:'served by another host'});
  await getStore().setDoc(`${paths.site('org','site')}/publishing_targets/main`,{last_publication:{publication_id:'pub',snapshot_job_id:'job'}});
  const guide=await readDomainGuide('org','site');
  expect(guide).toMatchObject({state:'live',traffic_live:false,next_action:'remove_other_host',current_phase:'Another host is serving example.com'});
  expect(guide.checks.find(check=>check.id==='serving:example.com')).toMatchObject({status:'action_required',message:issue.message,details:{code:'domain_served_by_other_host',remedy:issue.remedy}});
});

it('reports a live host whose Pages custom domain is not active and retries validation on request (CH-07)', async () => {
  const {siteDomainConfigPath}=await import('../../lib/publishing/domain-config');
  const config=await getSiteDomains('org','site');
  const route='/accounts/account/pages/projects/proj/domains/example.com';
  let pages: Record<string, unknown>={status:'deactivated',validation_data:{method:'http',status:'deactivated'}};
  mocks.provider.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path===route) { if (options?.method==='PATCH') pages={status:'pending'}; return pages; }
    if (path.startsWith('/zones?')) return [{ id: 'zone', name: 'example.com', status: 'active', account: { id: 'account' }, name_servers: ['ns1.example.net', 'ns2.example.net'] }];
    if (path.startsWith('/zones/zone/dns_records')) { if (options?.method) throw new Error('DNS must never be written'); return [{ id: 'dns', type: 'CNAME', name: 'example.com', content: 'proj.pages.dev', proxied: true }]; }
    return [{ certificate_status: 'active', hosts: ['example.com', '*.example.com'] }];
  });
  const issue={code:'pages_domain_not_active',host:'example.com',status:'deactivated',retryable:true,remedy:'Remove it from the previous host.',message:'The Cloudflare Pages custom domain example.com is deactivated, not active.'};
  await getStore().updateDoc(siteDomainConfigPath('org','site'),{state:'live',active:config.desired,published:{hosts:config.desired,dns_mode:'automatic',publication_id:'pub',job_id:'job'},
    serving_check:{status:'inconclusive',publication_id:'pub',website_host:'example.com',job_id:'job',live_at:new Date().toISOString(),checked_at:new Date().toISOString(),next_check_at:null,hosts:[],observed:null,issue:null,
      pages_domain:{host:'example.com',status:'deactivated',validation_method:'http',validation_status:'deactivated',error_message:null,checked_at:new Date().toISOString(),retried_at:null,retry:null},pages_issue:issue}});
  await getStore().setDoc(paths.deploy('org','site','job'),{status:'succeeded',phase:'Pages custom domain not active'});
  await getStore().setDoc(`${paths.site('org','site')}/publishing_targets/main`,{last_publication:{publication_id:'pub',snapshot_job_id:'job',account_id:'account',project:'proj',hosting_group_id:'default'}});
  const guide=await readDomainGuide('org','site');
  expect(guide).toMatchObject({state:'live',traffic_live:false,next_action:'retry_validation',current_phase:'Cloudflare Pages does not serve example.com (custom domain deactivated)'});
  expect(guide.checks.find(check=>check.id==='pages_domain:example.com')).toMatchObject({status:'action_required',message:issue.message,details:{code:'pages_domain_not_active',status:'deactivated',retryable:true}});
  // Reading never retries validation.
  expect(mocks.provider.mock.calls.some(([, options])=>options?.method)).toBe(false);

  network.respond = () => new Response(null, { status: 522 });
  const retried=await domainGuideAction('org','site',{action:'retry_validation'}) as Awaited<ReturnType<typeof readDomainGuide>>;
  expect(mocks.provider.mock.calls.filter(([path, options])=>path===route&&options?.method==='PATCH')).toHaveLength(1);
  expect(retried.serving_check).toMatchObject({pages_domain:{status:'pending',retry:'requested'},pages_issue:{status:'pending'}});
  expect(retried.next_action).toBe('retry_validation');
  // Idempotent: an immediate repeat does not retry again.
  await domainGuideAction('org','site',{action:'retry_validation'});
  expect(mocks.provider.mock.calls.filter(([path, options])=>path===route&&options?.method==='PATCH')).toHaveLength(1);

  pages={status:'active'};
  network.respond = () => new Response(null, { headers: { 'x-typeroll-publication': 'pub' } });
  const healed=await domainGuideAction('org','site',{action:'retry_validation'}) as Awaited<ReturnType<typeof readDomainGuide>>;
  expect(healed).toMatchObject({traffic_live:true,next_action:'none'});
  expect(healed.checks.find(check=>check.id==='pages_domain:example.com')).toMatchObject({status:'ready'});
});
it('rejects a validation retry for a host that is not live', async () => {
  await expect(domainGuideAction('org','site',{action:'retry_validation'})).rejects.toMatchObject({code:'pages_validation_not_applicable'});
});
it('warns before the switch that a previous Cloudflare for SaaS host must release the domain (CH-07)', async () => {
  const {siteDomainConfigPath}=await import('../../lib/publishing/domain-config');
  await getStore().updateDoc(siteDomainConfigPath('org','site'),{state:'ready_to_switch',candidate:{id:'cand',job_id:'job'},
    preparation:{hostname:'example.com',provider_status:'pending',certificate_ready:false,requirements:[],dns_fingerprint:'f',action:'complete_validation',has_existing_traffic:true,validation_blocker:null}});
  network.respond = () => new Response(null, { status: 200, headers: { 'x-kinsta-cache': 'HIT' } });
  const guide=await readDomainGuide('org','site');
  expect(guide.checks.find(check=>check.id==='previous_host_saas:example.com')).toMatchObject({status:'external',details:{code:'previous_host_saas_hostname',provider:{provider:'kinsta'}}});
  expect(guide.switch_summary.previous_host).toMatchObject({code:'previous_host_saas_hostname',message:expect.stringContaining('right before or right after approving the switch')});
  // A warning only: it never blocks preparation.
  expect(guide.checks.find(check=>check.id==='host_requirements')?.status).toBe('ready');
  expect(guide.can_prepare).toBe(true);
});
