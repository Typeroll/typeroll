// Live snippets and live site fields: where live files go (the public media
// bucket under the site's namespace, on the site's or the organization's
// media host), the per-site CORS rule merged into the bucket's policy, the
// v1 routes with sanitizing, revision checks and limits, live site fields,
// and the launch check. Storage and Cloudflare are faked; nothing reaches
// the network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, MAX_SNIPPETS, paths, type Site } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'ownerorg';
const READER = 'readerorg';
const SITE = 'mysite';
const ACCOUNT = 'a'.repeat(32);
let adminToken = '';
let readToken = '';
let objects: Map<string, { body: string; contentType?: string; cacheControl?: string }>;
let corsRules: Array<{ id?: string; allowed?: { origins?: string[]; methods?: string[] } }>;
let corsPuts = 0;
let failPut = false;

async function store() { return (await import('../../lib/datastore')).getStore(); }

async function setup(options: { mediaHost?: 'site' | 'organization' | 'none'; hosted?: boolean } = {}) {
  makeTmpFixtures();
  await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://portal.example.test');
  const s = await store();
  await s.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString(), media_id: 'abc123defg', domain: 'www.example.com',
    ...(options.hosted ? { publishing_mode: 'hosted' } : {}) } satisfies Partial<Site>);
  await s.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString() });
  await s.setDoc(paths.settings(ORG, SITE), { site_name: 'My Site', language: 'nb' });
  const { connectionPath, sealCredentials, getConnection } = await import('../../lib/publishing/connections');
  await getConnection(ORG, 'cloudflare');
  await s.updateDoc(connectionPath(ORG, 'cloudflare'), { status: 'connected', media_ready: true, auth_method: 'api_token',
    cloudflare: { account_id: ACCOUNT, account_name: 'Agency', bucket: 'agency-originals', public_bucket: 'agency-public', endpoint: 'https://example.test' },
    encrypted_credentials: sealCredentials(ORG, 'cloudflare', { api_token: 'synthetic-cf', access_key_id: 'synthetic-key', secret_access_key: 'synthetic-secret' }) });
  const { getSiteDomains, siteDomainConfigPath, getOrganizationDomains, organizationDomainConfigPath } = await import('../../lib/publishing/domain-config');
  await getSiteDomains(ORG, SITE);
  await getOrganizationDomains(ORG);
  if (options.mediaHost === 'site' || options.mediaHost === undefined) {
    await s.updateDoc(siteDomainConfigPath(ORG, SITE), { active: { website_host: 'www.example.com', media_host: 'media.example.com', media_path_prefix: '' } });
  }
  if (options.mediaHost === 'organization') await s.updateDoc(organizationDomainConfigPath(ORG), { media_host: 'media.agency.test' });
  const { createApiKey } = await import('../../lib/api-keys');
  adminToken = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'admin', createdBy: 'admin' })).token;
  const { writeShare } = await import('../../lib/shares');
  await writeShare({ id: 'share-r', site_id: SITE, owner_org_id: ORG, shared_with_org_id: READER, permission: 'read', created_at: Date.now(), created_by: 'owner@example.com' });
  readToken = (await createApiKey({ orgId: READER, siteId: null, name: 'reader', createdBy: 'reader' })).token;
}

beforeEach(() => {
  objects = new Map(); corsRules = [{ id: 'typeroll-direct-uploads', allowed: { origins: ['https://portal.example.test'], methods: ['GET', 'HEAD', 'PUT'] } }];
  corsPuts = 0; failPut = false;
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      if (failPut) throw new Error('R2 is unavailable');
      const input = command.input;
      objects.set(`${input.Bucket}/${input.Key}`, { body: String(input.Body), contentType: input.ContentType, cacheControl: input.CacheControl });
      return {};
    }
    if (command instanceof DeleteObjectCommand) { objects.delete(`${command.input.Bucket}/${command.input.Key}`); return {}; }
    throw new Error('Unexpected S3 operation');
  }) as never);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === `/client/v4/accounts/${ACCOUNT}/r2/buckets/agency-public/cors`) {
      if (init?.method === 'PUT') { corsPuts++; corsRules = JSON.parse(String(init.body)).rules; }
      return Response.json({ success: true, result: { rules: corsRules } });
    }
    return new Response('Unexpected request', { status: 500 });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';
async function call(method: Method, rest = '', body?: unknown, token = adminToken): Promise<Response> {
  const route = rest ? '[snippetId]' : 'index';
  const mod = (await import(/* @vite-ignore */ `../../pages/api/v1/sites/[siteId]/snippets/${route}`)) as Partial<Record<string, APIRoute>>;
  const id = rest.split('?')[0]!.replace(/^\//, '');
  const request = new Request(`http://localhost/api/v1/sites/${SITE}/snippets${rest}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body != null ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request, params: { siteId: SITE, ...(id ? { snippetId: id } : {}) }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

const lunch = {
  name: 'Lunch', kind: 'dated', format: 'html',
  entries: [{ weekday: 'monday', content: '<p onclick="steal()">Pea soup<script>alert(1)</script></p>' }, { date: '2026-12-24', content: '<p>Closed</p>' }],
  fallback: '<p>No lunch today</p>',
};
const KEY = 'agency-public/media/abc123defg/live';

describe('live file target', () => {
  it('uses the site media host, else the organization host under the site namespace, else none', async () => {
    const { liveBaseUrl, liveFilesTarget } = await import('../../lib/publishing/live-files');
    await setup({ mediaHost: 'site' });
    expect(await liveBaseUrl(ORG, SITE)).toBe('https://media.example.com/live');
    await setup({ mediaHost: 'organization' });
    expect(await liveBaseUrl(ORG, SITE)).toBe('https://media.agency.test/media/abc123defg/live');
    await setup({ mediaHost: 'none' });
    expect(await liveBaseUrl(ORG, SITE)).toBeNull();
    expect(await liveFilesTarget(ORG, SITE)).toMatchObject({ available: false, reason: 'no_media_host' });
    await setup({ hosted: true });
    expect(await liveFilesTarget(ORG, SITE)).toMatchObject({ available: false, reason: 'hosted_site' });
  });
});

describe('snippet routes', () => {
  beforeEach(async () => { await setup(); });

  it('creates a sanitized snippet, stamps it and writes the live file with a short cache', async () => {
    const created = await call('POST', '', { id: 'lunch', ...lunch });
    expect(created.status).toBe(201);
    const body = await created.json() as { snippet: { entries: Array<{ content: string }>; updated_by: string; updated_at: string }; live: unknown };
    expect(body.snippet.entries[0]!.content).toBe('<p>Pea soup</p>');
    expect(body.snippet.updated_by).toMatch(/^api-key:/);
    expect(body.live).toEqual({ published: true, url: 'https://media.example.com/live/lunch.json' });
    const file = objects.get(`${KEY}/lunch.json`)!;
    expect(file.contentType).toBe('application/json; charset=utf-8');
    expect(file.cacheControl).toBe('public, max-age=60, stale-while-revalidate=600');
    const published = JSON.parse(file.body);
    expect(published).toMatchObject({ id: 'lunch', kind: 'dated', time_zone: 'Europe/Oslo', fallback: '<p>No lunch today</p>', updated_at: body.snippet.updated_at });
    expect(published).not.toHaveProperty('updated_by');
    expect((await call('POST', '', { id: 'lunch', ...lunch })).status).toBe(409);
  });

  it('adds a CORS rule for the site\'s addresses once, merged with the bucket\'s other rules', async () => {
    await call('PUT', '/notice', { name: 'Notice', kind: 'text', content: 'Closed today' });
    await call('PUT', '/notice', { name: 'Notice', kind: 'text', content: 'Open again' });
    expect(corsPuts).toBe(1);
    const { liveCorsRuleId } = await import('../../lib/publishing/live-files');
    expect(corsRules.map((rule) => rule.id)).toEqual(['typeroll-direct-uploads', liveCorsRuleId(SITE)]);
    // Only the site's own addresses: portal previews fetch no live files (and run in an opaque origin).
    expect(corsRules[1]!.allowed).toEqual({ origins: ['https://www.example.com'], methods: ['GET', 'HEAD'] });
    // A new address of the site refreshes the rule before the next write.
    await (await store()).setDoc(paths.version(ORG, SITE, 'redesign'), { name: 'Redesign', kind: 'branch', deploy_url: 'https://redesign.example.pages.dev' });
    await call('PUT', '/notice', { name: 'Notice', kind: 'text', content: 'Closed again' });
    expect(corsPuts).toBe(2);
    expect(corsRules[1]!.allowed!.origins).toContain('https://redesign.example.pages.dev');
  });

  it('replaces with the revision check and creates a missing snippet', async () => {
    const first = await (await call('PUT', '/notice', { name: 'Notice', kind: 'text', content: 'A', expected_updated_at: '' })).json() as { snippet: { updated_at: string } };
    const second = await call('PUT', '/notice', { name: 'Notice', kind: 'text', content: 'B', expected_updated_at: first.snippet.updated_at });
    expect(second.status).toBe(200);
    const stamped = (await second.json() as { snippet: { updated_at: string } }).snippet.updated_at;
    expect(Date.parse(stamped)).toBeGreaterThan(Date.parse(first.snippet.updated_at));
    expect((await call('PUT', '/notice', { name: 'Notice', kind: 'text', content: 'C', expected_updated_at: first.snippet.updated_at })).status).toBe(409);
    expect((await call('PUT', '/other', { name: 'Other', kind: 'text', content: 'x', expected_updated_at: stamped })).status).toBe(409);
    expect((await call('PUT', '/notice', { id: 'renamed', name: 'Notice', kind: 'text', content: 'x' })).status).toBe(400);
    const read = await (await call('GET', '/notice')).json() as { snippet: { content: string }; live_url: string };
    expect(read).toMatchObject({ snippet: { content: 'B' }, live_url: 'https://media.example.com/live/notice.json' });
  });

  it('reports invalid input with paths, refuses readers and keeps at most the limit', async () => {
    const invalid = await call('POST', '', { id: 'bad', name: 'Bad', kind: 'dated', entries: [{ weekday: 'funday', content: 'x' }] });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { details: { errors: Array<{ path: string }> } }).details.errors.map((e) => e.path)).toEqual(['entries[0].weekday']);
    expect((await call('PUT', '/notice', { name: 'Notice', kind: 'text', content: 'x' }, readToken)).status).toBe(403);
    expect((await call('GET', '', undefined, readToken)).status).toBe(200);
    const s = await store();
    for (let i = 0; i < MAX_SNIPPETS; i++) await s.setDoc(paths.snippet(ORG, SITE, `s${i}`), { name: `S${i}`, kind: 'text', content: '' });
    const over = await call('POST', '', { id: 'one-more', name: 'One more', kind: 'text', content: 'x' });
    expect(over.status).toBe(409);
    expect((await over.json() as { error: string }).error).toContain(`at most ${MAX_SNIPPETS}`);
  });

  it('saves even when the live file cannot be written, and says why', async () => {
    failPut = true;
    const saved = await call('PUT', '/notice', { name: 'Notice', kind: 'text', content: 'x' });
    expect(saved.status).toBe(201);
    expect((await saved.json() as { live: unknown }).live).toMatchObject({ published: false, code: 'write_failed', reason: expect.stringContaining('next publication') });
    await setup({ mediaHost: 'none' });
    const unserved = await (await call('PUT', '/notice', { name: 'Notice', kind: 'text', content: 'x' })).json() as { live: unknown };
    expect(unserved.live).toMatchObject({ published: false, code: 'no_media_host' });
    const list = await (await call('GET')).json() as { snippets: unknown[]; live: { base_url: null; reason: string } };
    expect(list.snippets).toHaveLength(1);
    expect(list.live).toMatchObject({ base_url: null, reason: expect.stringContaining('media host') });
  });

  it('lists by name and deletes the snippet with its live file', async () => {
    await call('PUT', '/notice', { name: 'Notice', kind: 'text', content: 'x' });
    await call('PUT', '/lunch', lunch);
    expect(((await (await call('GET')).json()) as { snippets: Array<{ id: string }> }).snippets.map((s) => s.id)).toEqual(['lunch', 'notice']);
    const stamp = ((await (await call('GET', '/notice')).json()) as { snippet: { updated_at: string } }).snippet.updated_at;
    expect((await call('DELETE', '/notice?expected_updated_at=old')).status).toBe(409);
    const deleted = await call('DELETE', `/notice?expected_updated_at=${encodeURIComponent(stamp)}`);
    expect(await deleted.json()).toEqual({ ok: true, live: { deleted: true } });
    expect(objects.has(`${KEY}/notice.json`)).toBe(false);
    expect((await call('GET', '/notice')).status).toBe(404);
    expect((await call('DELETE', '/notice')).status).toBe(404);
  });
});

describe('live site fields', () => {
  beforeEach(async () => { await setup(); });

  it('publishes only live fields on main, and removes the file when no field is live', async () => {
    const { defineSiteFields, updateSiteFieldValues } = await import('../../lib/site-fields-write');
    const ctx = { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID };
    const groups = [{ id: 'shop', label: 'Shop', fields: [
      { name: 'delivery_days', type: 'number', label: 'Delivery days', live: true },
      { name: 'address', type: 'text', label: 'Address' },
    ] }];
    await defineSiteFields(ctx, groups, { permission: 'admin', updatedBy: 'admin' });
    const saved = await updateSiteFieldValues(ctx, { delivery_days: 3, address: 'Main street 1' }, { permission: 'write', updatedBy: 'editor' });
    expect(saved.live).toEqual({ published: true, url: 'https://media.example.com/live/_fields.json' });
    expect(JSON.parse(objects.get(`${KEY}/_fields.json`)!.body)).toEqual({ values: { delivery_days: 3 }, time_zone: 'Europe/Oslo', updated_at: saved.updated_at });
    // A change to a field that is not live writes nothing.
    objects.delete(`${KEY}/_fields.json`);
    expect((await updateSiteFieldValues(ctx, { address: 'Side street 2' }, { permission: 'write', updatedBy: 'editor' })).live).toBeUndefined();
    expect(objects.has(`${KEY}/_fields.json`)).toBe(false);
    // A branch is not live.
    expect((await updateSiteFieldValues({ ...ctx, versionId: 'redesign' }, { delivery_days: 9 }, { permission: 'write', updatedBy: 'editor' }).catch(() => ({ live: undefined }))).live).toBeUndefined();
    await updateSiteFieldValues(ctx, { delivery_days: 4 }, { permission: 'write', updatedBy: 'editor' });
    expect(JSON.parse(objects.get(`${KEY}/_fields.json`)!.body).values).toEqual({ delivery_days: 4 });
    const { siteFields } = await defineSiteFields(ctx, [{ ...groups[0]!, fields: groups[0]!.fields.map(({ live: _live, ...field }) => field) }], { permission: 'admin', updatedBy: 'admin' });
    expect(siteFields.live).toEqual({ published: false, removed: true });
    expect(objects.has(`${KEY}/_fields.json`)).toBe(false);
  });
});

describe('organization media setup', () => {
  it('applies the rule of every site with live content and republishes its files', async () => {
    await setup();
    const s = await store();
    await s.setDoc(paths.snippet(ORG, SITE, 'notice'), { name: 'Notice', kind: 'text', format: 'text', content: 'Saved before storage was ready' });
    await s.setDoc(paths.site(ORG, 'quiet'), { name: 'Quiet site', created_at: '' });
    const { refreshOrganizationLiveCors, liveCorsRuleId } = await import('../../lib/publishing/live-files');
    const { cloudflareClient } = await import('../../lib/publishing/cloudflare-oauth');
    expect(await refreshOrganizationLiveCors(ORG, await cloudflareClient(ORG))).toBe(1);
    expect(corsRules.map((rule) => rule.id)).toEqual(['typeroll-direct-uploads', liveCorsRuleId(SITE)]);
    const { republishOrganizationLiveFiles } = await import('../../lib/live-content-sync');
    await republishOrganizationLiveFiles(ORG);
    expect(JSON.parse(objects.get(`${KEY}/notice.json`)!.body)).toMatchObject({ id: 'notice', content: 'Saved before storage was ready' });
  });
});
