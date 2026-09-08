import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { paths } from '@typeroll/shared';
import type { DeployJob, SiteVersion } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { probePublication, refreshDeploymentAvailability, stampPublication } from '../../lib/deploy/availability';
import { pageLiveUrl } from '../../lib/site-urls';

const org = 'availability-org', site = 'availability-site';
const oldTime = '2026-09-07T10:00:00Z', cutoff = '2026-09-07T11:00:00Z';
const job: DeployJob = { id: 'new-upload', version_id: 'main', environment: 'production', status: 'running', phase: 'distributing', started_at: cutoff,
  deploy_url: 'https://new.example.com', availability: { id: 'publication-new', content_cutoff: cutoff, origins: ['https://public.example.com'], paths: ['/', '/new-page/'], checked: 0 } };
async function seed(overrides: Partial<DeployJob> = {}) {
  const store = getStore();
  await store.setDoc(paths.version(org, site, 'main'), { name: 'Main', kind: 'main', created_at: oldTime, last_deployed_at: oldTime, last_deployed_content_at: oldTime, distributing_deploy_id: 'publication-new' });
  const current = { ...job, ...overrides };
  await store.setDoc(paths.deploy(org, site, job.id), current);
  return current;
}

describe('public deployment readiness', () => {
  beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });
  it('rejects stale HTTP 200 responses and unavailable pages', async () => {
    const validate = vi.fn(async () => {});
    for (const response of [new Response(null, { status: 404 }), new Response(null, { status: 200 }), new Response(null, { headers: { 'x-typeroll-publication': 'old' } })]) {
      expect(await probePublication('https://example.com', '/new/', 'new', { validate, fetchImpl: vi.fn(async () => response) })).toBe(false);
    }
    expect(await probePublication('https://example.com', '/new/', 'new', { validate, fetchImpl: vi.fn(async () => new Response(null, { headers: { 'x-typeroll-publication': 'new' } })) })).toBe(true);
  });
  it('rejects cross-origin redirects and private destinations', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://other.example.com' } }));
    expect(await probePublication('https://example.com', '/', 'new', { validate: async () => {}, fetchImpl })).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();
    expect(await probePublication('https://127.0.0.1', '/', 'new', { fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('keeps links hidden until every route matches the uploaded publication', async () => {
    const current = await seed(), store = getStore();
    const version = () => store.getDoc<SiteVersion>(paths.version(org, site, 'main'));
    const page = { slug: 'home', status: 'published' as const, date_updated: oldTime };
    expect(pageLiveUrl({ domain: 'public.example.com' }, await version(), page)).toBeNull();
    const pending = await refreshDeploymentAvailability(org, site, current, { probe: async (_origin, route) => route === '/' });
    expect(pending.status).toBe('running');
    expect((await version())?.last_deployed_at).toBe(oldTime);
    const ready = await refreshDeploymentAvailability(org, site, current, { probe: async () => true, now: () => '2026-09-07T11:02:00Z' });
    expect(ready.status).toBe('succeeded');
    expect((await version())?.last_deployed_content_at).toBe(cutoff);
    expect(pageLiveUrl({ domain: 'public.example.com' }, await version(), page)).toBe('https://public.example.com/');
  });
  it('resumes verification in bounded batches after the worker has finished', async () => {
    const current = await seed({ availability: { ...job.availability!, paths: Array.from({ length: 10 }, (_, i) => `/page-${i}/`) } });
    const probe = vi.fn(async () => true);
    const first = await refreshDeploymentAvailability(org, site, current, { probe });
    expect(first.status).toBe('running');
    expect(first.availability?.checked).toBe(8);
    const second = await refreshDeploymentAvailability(org, site, first, { probe });
    expect(second.status).toBe('succeeded');
    expect(probe).toHaveBeenCalledTimes(10);
  });
  it('does not let an obsolete upload promote a newer version', async () => {
    const current = await seed();
    await getStore().updateDoc(paths.version(org, site, 'main'), { distributing_deploy_id: 'newer-upload' });
    expect((await refreshDeploymentAvailability(org, site, current, { probe: async () => true })).status).toBe('failed');
    expect((await getStore().getDoc<SiteVersion>(paths.version(org, site, 'main')))?.last_deployed_at).toBe(oldTime);
  });
  it('verifies staging without advancing main production state', async () => {
    const current = await seed({ environment: 'staging' });
    expect((await refreshDeploymentAvailability(org, site, current, { probe: async () => true })).status).toBe('succeeded');
    expect((await getStore().getDoc<SiteVersion>(paths.version(org, site, 'main')))?.last_deployed_at).toBe(oldTime);
  });
  it('allows retry after a prolonged unavailable host without exposing its link', async () => {
    const current = await seed({ availability: { ...job.availability!, uploaded_at: oldTime } });
    const result = await refreshDeploymentAvailability(org, site, current, { probe: async () => false, now: () => cutoff });
    expect(result.status).toBe('failed');
    expect(result.phase).toBe('availability_timeout');
    const version = await getStore().getDoc<SiteVersion>(paths.version(org, site, 'main'));
    expect(version?.distributing_deploy_id).toBe('publication-new');
    expect(version?.last_deployed_at).toBe(oldTime);
  });
  it('can verify a publication after its last public page was removed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'typeroll-empty-publication-'));
    try {
      await fs.writeFile(path.join(dir, '404.html'), 'Not found');
      const stamp = await stampPublication(dir);
      expect(stamp.paths).toEqual(['/.well-known/typeroll/publication.txt']);
      expect(await fs.readFile(path.join(dir, '.well-known/typeroll/publication.txt'), 'utf8')).toBe(stamp.id);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('stamps static files without adding a Worker or requiring a homepage', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'typeroll-availability-'));
    try {
      await fs.mkdir(path.join(dir, 'nested'));
      await fs.writeFile(path.join(dir, 'nested/index.html'), '<h1>Nested</h1>');
      await fs.writeFile(path.join(dir, '404.html'), 'Not found');
      await fs.writeFile(path.join(dir, '_headers'), '/*\n  X-Robots-Tag: noindex\n');
      const stamp = await stampPublication(dir);
      expect(stamp.paths).toEqual(['/nested/']);
      expect(await fs.readFile(path.join(dir, '_headers'), 'utf8')).toContain(`X-Typeroll-Publication: ${stamp.id}`);
      expect(await fs.readdir(dir)).not.toContain('_worker.js');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

it('records publication mismatch and network failures without reflecting response or error secrets', async () => {
  const observed: any[] = [];
  const observe = async (value: any) => { observed.push(value); };
  const validate = async () => {};
  expect(await probePublication('https://example.com', '/', 'expected', { validate, observe,
    fetchImpl: async () => new Response(null, { headers: { 'x-typeroll-publication': 'previous' } }) })).toBe(false);
  expect(observed[0]).toMatchObject({ ready: false, reason: 'publication_mismatch', http_status: 200, observed_publication: 'previous' });
  expect(await probePublication('https://example.com', '/', 'expected', { validate, observe,
    fetchImpl: async () => { throw Object.assign(new Error('secret diagnostic payload'), { cause: { code: 'CERT_HAS_EXPIRED' } }); } })).toBe(false);
  expect(observed[1]).toMatchObject({ ready: false, reason: 'network_or_tls', network_code: 'CERT_HAS_EXPIRED' });
  expect(JSON.stringify(observed)).not.toContain('secret');
});
