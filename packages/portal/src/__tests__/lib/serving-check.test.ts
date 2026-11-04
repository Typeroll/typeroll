import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { workPath } from '../../lib/scheduling/index';
import { executeScheduledWork } from '../../lib/scheduling/worker';
import { siteDomainConfigPath, type DomainConfiguration } from '../../lib/publishing/domain-config';

// Scheduled checks use the module's guarded transport; the network is a fake here.
const network = vi.hoisted(() => ({ respond: (() => { throw new Error('no network in tests'); }) as (url: URL, init?: RequestInit) => Response }));
vi.mock('../../lib/net/safe-fetch', async load => ({
  ...await load<object>(),
  createSafeFetch: () => (async (input: string | URL, init?: RequestInit) => network.respond(new URL(String(input)), init)) as typeof fetch,
}));
const deploy = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../lib/deploy/queue', () => ({ executeDeployJob: deploy.execute, getDeployQueue: () => ({ enqueue: vi.fn() }) }));
// The Pages custom domain is read through the hosting account; DNS through the zone's account.
const cloudflare = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => cloudflare.provider }));
vi.mock('../../lib/publishing/hosting-dns', () => ({ hostingDns: async () => ({ provider: cloudflare.provider, accountId: 'account', groupId: 'default' }) }));

import { recordServingCheck, refreshServingAlarm, retryPagesValidation, scheduleServingChecks } from '../../lib/publishing/serving-check';
import { ProviderError } from '../../lib/publishing/providers.mjs';

const publication = 'a'.repeat(64);
const marker = '/.well-known/typeroll/publication.json';
const configPath = siteDomainConfigPath('org', 'site'), jobPath = paths.deploy('org', 'site', 'job');
const workId = workPath(configPath, 'domain_serving_check').split('/').pop()!;
const live = Date.parse('2026-10-28T09:00:00.000Z');
const minutes = (value: number) => live + value * 60_000;

const typeroll = (id = publication) => (url: URL) => url.pathname === marker
  ? Response.json({ id, paths: ['/'] }, { headers: { 'x-typeroll-publication': id } })
  : new Response(null, { headers: { 'x-typeroll-publication': id } });
const kinsta = (url: URL) => new Response(null, { status: url.pathname === marker ? 404 : 200, headers: { 'x-kinsta-cache': 'HIT', server: 'cloudflare' } });
const down = () => { throw new TypeError('fetch failed'); };

const hosts = { website_host: 'moveria.ch', media_host: null, media_path_prefix: '' };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  network.respond = typeroll();
  await getStore().setDoc(configPath, { revision: 'r1', desired: hosts, active: hosts, media_aliases: [], dns_mode: 'automatic', state: 'live',
    published: { hosts, dns_mode: 'automatic', publication_id: publication, job_id: 'job' } } satisfies DomainConfiguration);
  await getStore().setDoc(jobPath, { status: 'succeeded', phase: 'live', version_id: 'main', environment: 'production', finished_at: new Date(live).toISOString() });
});
afterEach(() => vi.restoreAllMocks());

async function deliver(at: number) {
  const work = await getStore().getDoc<any>(`scheduled_work/${workId}`);
  await executeScheduledWork(workId, work.generation, new Date(at));
  return getStore().getDoc<any>(`scheduled_work/${workId}`);
}
const config = async () => (await getStore().getDoc<DomainConfiguration>(configPath))!;

it('indexes durable follow-up checks at about 2, 10 and 30 minutes after going live', async () => {
  await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'moveria.ch', job_id: 'job' }, live);
  expect(await getStore().getDoc<any>(`scheduled_work/${workId}`)).toMatchObject({ kind: 'domain_serving_check', source: configPath, due_at: minutes(2) });
  expect((await config()).serving_check).toMatchObject({ status: 'pending', publication_id: publication, next_check_at: new Date(minutes(2)).toISOString() });

  // An early delivery does nothing; each due check moves the same entry to the next time.
  expect((await deliver(minutes(1))).due_at).toBe(minutes(2));
  expect((await deliver(minutes(2))).due_at).toBe(minutes(10));
  expect((await config()).serving_check).toMatchObject({ status: 'serving', checked_at: new Date(minutes(2)).toISOString(), next_check_at: new Date(minutes(10)).toISOString() });
  expect((await deliver(minutes(10))).due_at).toBe(minutes(30));
  // Then once a day, for as long as the host is live.
  const day = 24 * 60 * 60_000;
  expect((await deliver(minutes(30))).due_at).toBe(minutes(30) + day);
  expect((await config()).serving_check).toMatchObject({ status: 'serving', next_check_at: new Date(minutes(30) + day).toISOString() });
  expect((await deliver(minutes(30) + day)).due_at).toBe(minutes(30) + 2 * day);
  expect(deploy.execute).not.toHaveBeenCalled();
});

it('raises a visible alarm when another host answers, keeps it through an inconclusive check and clears it on success', async () => {
  await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'moveria.ch', job_id: 'job' }, live);
  network.respond = kinsta;
  await deliver(minutes(2));
  expect((await config()).serving_check).toMatchObject({
    status: 'other_host', checked_at: new Date(minutes(2)).toISOString(),
    observed: { host: 'moveria.ch', publication: null, provider_hint: { provider: 'kinsta' } },
    issue: { code: 'domain_served_by_other_host', remedy: expect.stringContaining('MyKinsta → Domains') },
  });
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'succeeded', phase: 'served by another host',
    verification_message: expect.stringContaining('Cloudflare for SaaS hostname outranks your own DNS'),
    serving_check: { status: 'other_host', issue: { code: 'domain_served_by_other_host' } } });

  network.respond = down;
  await deliver(minutes(10));
  expect((await config()).serving_check).toMatchObject({ status: 'other_host', checked_at: new Date(minutes(2)).toISOString(), hosts: [{ status: 'inconclusive' }] });
  expect((await getStore().getDoc<any>(jobPath)).phase).toBe('served by another host');

  network.respond = typeroll();
  await deliver(minutes(30));
  expect((await config()).serving_check).toMatchObject({ status: 'serving', issue: null, observed: null });
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'succeeded', phase: 'live', verification_message: null, serving_check: { status: 'serving' } });
});

it('never raises an alarm from a transport error alone', async () => {
  await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'moveria.ch', job_id: 'job' }, live);
  network.respond = down;
  await deliver(minutes(2));
  expect((await config()).serving_check).toMatchObject({ status: 'inconclusive', issue: null });
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ phase: 'live' });
});

it('alarms on a different Typeroll publication and checks redirect hosts', async () => {
  const withRedirect = { ...hosts, website_host: 'www.moveria.ch', redirect_hosts: ['moveria.ch'] };
  await getStore().updateDoc(configPath, { active: withRedirect, desired: withRedirect, published: { hosts: withRedirect, dns_mode: 'automatic', publication_id: publication, job_id: 'job' } });
  await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'www.moveria.ch', job_id: 'job' }, live);
  network.respond = url => url.hostname === 'moveria.ch' ? kinsta(url) : typeroll()(url);
  await deliver(minutes(2));
  expect((await config()).serving_check).toMatchObject({ status: 'other_host', observed: { host: 'moveria.ch' },
    hosts: [{ host: 'www.moveria.ch', status: 'serving' }, { host: 'moveria.ch', role: 'redirect', status: 'other_host' }] });

  network.respond = typeroll('b'.repeat(64));
  expect(await recordServingCheck('org', 'site', { now: minutes(3) })).toMatchObject({ status: 'other_publication', issue: { code: 'domain_serving_other_publication' } });
});

it('stops when the domain is no longer live and never writes DNS or rolls back', async () => {
  await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'moveria.ch', job_id: 'job' }, live);
  await getStore().updateDoc(configPath, { state: 'distributing' });
  const requests: string[] = [];
  network.respond = url => { requests.push(url.href); return kinsta(url); };
  expect((await deliver(minutes(2))).due_at).toBe(Number.MAX_SAFE_INTEGER);
  expect(requests).toEqual([]);
  expect((await config()).state).toBe('distributing');
});

it('keeps a standing alarm when the host goes live again and re-checks it on read', async () => {
  await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'moveria.ch', job_id: 'job' }, live);
  network.respond = kinsta;
  await recordServingCheck('org', 'site', { now: Date.now() - 120_000 });
  await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'moveria.ch', job_id: 'job' }, Date.now());
  expect((await config()).serving_check).toMatchObject({ status: 'other_host' });

  const methods: string[] = [];
  network.respond = (url, init) => { methods.push(init?.method ?? 'GET'); return typeroll()(url); };
  const refreshed = await refreshServingAlarm('org', 'site', await config());
  expect(refreshed.serving_check).toMatchObject({ status: 'serving', issue: null });
  expect(methods.every(method => ['GET', 'HEAD'].includes(method))).toBe(true);
  // A fresh result is not re-checked on every poll.
  network.respond = (url, init) => { methods.push(init?.method ?? 'GET'); return kinsta(url); };
  await recordServingCheck('org', 'site');
  expect((await config()).serving_check?.status).toBe('other_host');
  methods.length = 0;
  await refreshServingAlarm('org', 'site', await config());
  expect(methods).toEqual([]);
});

describe('the Pages custom domain of the live website host (CH-07)', () => {
  const project = 'typeroll-83801dedcaff3704';
  const domainRoute = `/accounts/account/pages/projects/${project}/domains/moveria.ch`;
  let pages: Record<string, unknown> | Error;
  let record = { id: 'dns', type: 'CNAME', name: 'moveria.ch', content: `${project}.pages.dev`, proxied: true };
  const patches = () => cloudflare.provider.mock.calls.filter(([route, options]) => route === domainRoute && options?.method === 'PATCH').length;
  const edge522 = () => new Response(null, { status: 522, headers: { server: 'cloudflare' } });
  beforeEach(async () => {
    pages = { status: 'deactivated', validation_data: { method: 'http', status: 'deactivated' } };
    record = { id: 'dns', type: 'CNAME', name: 'moveria.ch', content: `${project}.pages.dev`, proxied: true };
    cloudflare.provider.mockImplementation(async (route: string, options?: { method?: string }) => {
      if (route === domainRoute) {
        if (pages instanceof Error) throw pages;
        if (options?.method === 'PATCH') { pages = { status: 'pending', validation_data: { method: 'http', status: 'pending' } }; return pages; }
        return pages;
      }
      if (route.startsWith('/zones?')) return [{ id: 'zone', name: 'moveria.ch', status: 'active', account: { id: 'account' } }];
      if (route.startsWith('/zones/zone/dns_records')) { if (options?.method) throw new Error('DNS must never be written'); return [record]; }
      throw new Error(`unexpected ${route}`);
    });
    await getStore().setDoc(`${paths.site('org', 'site')}/publishing_targets/main`, { last_publication: { publication_id: publication, account_id: 'account', project, hosting_group_id: 'default', branch: 'main' } });
  });

  it('alarms on a deactivated domain, retries validation once and clears when Cloudflare activates it', async () => {
    await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'moveria.ch', job_id: 'job' }, live);
    network.respond = edge522;
    await deliver(minutes(2));
    const check = (await config()).serving_check!;
    // HTTP 522 alone is inconclusive; the Pages status is the evidence.
    expect(check).toMatchObject({ status: 'inconclusive', issue: null,
      pages_domain: { host: 'moveria.ch', status: 'pending', retry: 'requested', dns_points_at_project: true, retried_at: new Date(minutes(2)).toISOString() },
      pages_issue: { code: 'pages_domain_not_active', host: 'moveria.ch', status: 'pending', retryable: true } });
    expect(check.pages_issue!.remedy).toContain('MyKinsta → Domains');
    expect(patches()).toBe(1);
    expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'succeeded', phase: 'Pages custom domain not active',
      verification_message: expect.stringContaining('moveria.ch is pending, not active'), serving_check: { pages_issue: { code: 'pages_domain_not_active' } } });

    // Rate-limited: a check within five minutes reads again without another retry.
    await recordServingCheck('org', 'site', { now: minutes(4) });
    expect(patches()).toBe(1);
    expect((await config()).serving_check?.pages_domain).toMatchObject({ status: 'pending', retry: 'rate_limited' });

    pages = { status: 'active' };
    network.respond = typeroll();
    await deliver(minutes(10));
    expect((await config()).serving_check).toMatchObject({ status: 'serving', pages_issue: null, pages_domain: { status: 'active' } });
    expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ phase: 'live', verification_message: null });
  });

  it('keeps the alarm through an inconclusive provider read and never retries while DNS points elsewhere', async () => {
    await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'moveria.ch', job_id: 'job' }, live);
    network.respond = edge522;
    record = { ...record, content: 'moveria.kinsta.cloud' };
    await deliver(minutes(2));
    expect((await config()).serving_check).toMatchObject({ pages_domain: { status: 'deactivated', retry: 'dns_not_pointing', dns_points_at_project: false }, pages_issue: { status: 'deactivated' } });
    expect(patches()).toBe(0);

    pages = new ProviderError('Cloudflare', 503);
    await deliver(minutes(10));
    expect((await config()).serving_check).toMatchObject({ pages_domain: { status: 'deactivated' }, pages_issue: { code: 'pages_domain_not_active' } });
    expect((await getStore().getDoc<any>(jobPath)).phase).toBe('Pages custom domain not active');
  });

  it('checks the Pages domain daily after the first series, so a domain that drops out of active raises an alarm', async () => {
    pages = { status: 'active' };
    await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'moveria.ch', job_id: 'job' }, live);
    for (const at of [2, 10, 30]) await deliver(minutes(at));
    expect((await config()).serving_check).toMatchObject({ status: 'serving', pages_issue: null });
    pages = { status: 'deactivated' };
    const day = 24 * 60 * 60_000;
    expect((await deliver(minutes(30) + day)).due_at).toBe(minutes(30) + 2 * day);
    expect((await config()).serving_check).toMatchObject({ pages_issue: { code: 'pages_domain_not_active' } });
    expect(patches()).toBe(1);
  });

  it('retries validation explicitly at most once a minute and backfills checks for a host that went live earlier', async () => {
    // Live before follow-up checks existed: no serving_check yet.
    network.respond = edge522;
    const before = await config();
    expect(before.serving_check).toBeUndefined();
    await retryPagesValidation('org', 'site');
    expect((await config()).serving_check).toMatchObject({ pages_issue: { status: 'pending' }, pages_domain: { retry: 'requested' } });
    expect(await getStore().getDoc<any>(`scheduled_work/${workId}`)).toMatchObject({ kind: 'domain_serving_check' });
    expect(patches()).toBe(1);
    pages = { status: 'deactivated' };
    await retryPagesValidation('org', 'site');
    expect(patches()).toBe(1);
    // Past a minute, an explicit request retries even inside the automatic interval.
    const saved = (await config()).serving_check!;
    await getStore().updateDoc(configPath, { serving_check: { ...saved, pages_domain: { ...saved.pages_domain!, retried_at: new Date(Date.now() - 90_000).toISOString() } } });
    await retryPagesValidation('org', 'site');
    expect(patches()).toBe(2);
  });

  it('skips the Pages read when the publishing project is unknown', async () => {
    await getStore().setDoc(`${paths.site('org', 'site')}/publishing_targets/main`, {});
    await scheduleServingChecks('org', 'site', { publication_id: publication, website_host: 'moveria.ch', job_id: 'job' }, live);
    await deliver(minutes(2));
    expect((await config()).serving_check).toMatchObject({ status: 'serving', pages_domain: null, pages_issue: null });
    expect(cloudflare.provider).not.toHaveBeenCalled();
  });
});
