import { beforeEach, afterEach, expect, it, vi } from 'vitest';
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

import { recordServingCheck, refreshServingAlarm, scheduleServingChecks } from '../../lib/publishing/serving-check';

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
  expect((await deliver(minutes(30))).due_at).toBe(Number.MAX_SAFE_INTEGER);
  expect((await config()).serving_check).toMatchObject({ status: 'serving', next_check_at: null });
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
