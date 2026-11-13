// Moveria (Core 0.3.29): 16 deleted photos of private persons stayed public on
// the organization's media host. Deleting a record removed its private
// objects at best (the API route not even those), while the copies every
// publication wrote into the PUBLIC bucket — base file, .v2 variants,
// receipts, share copies, on each media host's key — were never removed, and
// Cloudflare's cache kept serving them. These pin that a delete removes every
// copy and purges every URL, that shared bytes survive, that already-deleted
// media can be cleaned up by id or URL through the API, and that failures and
// a missing Cache Purge permission are reported rather than swallowed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIN_VERSION_ID, paths, type Media } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'moveria-ab';
const SITE = 'moveria-fi';
const PREFIX = 'media/spyuth63gr';
const ORG_HOST = 'media.moveria.com';
const SITE_HOST = 'media.moveria.fi';
const SHA = '630c00d43ea74e18' + 'a'.repeat(48);
const NAME = '549772_10151365125161284_1937133894_n.jpg';
const BASE = `${PREFIX}/630c00d43ea74e18-${NAME}`;
const variant = (slot: string, format: string) => `.v2.${slot}.630c00d43ea74e18.${format}`;
// Every object the build writes for one image on the organization host, plus the same file under a site media host path.
const COPIES = [BASE, BASE + variant('original', 'webp'), BASE + variant('original', 'avif'), BASE + variant('w320', 'webp'),
  BASE + variant('w320', 'webp') + '.receipt.json', BASE + `.prepared-v2.${'b'.repeat(64)}.json`, BASE + '.share-s1.photo.630c00d43ea74e18.jpg'];
const SITE_KEY = `${PREFIX}/images/630c00d43ea74e18-${NAME}`;
const ORIGINAL = `private/${PREFIX}/originals/${SHA}/${NAME}`;
const PREPARED = [`private/${PREFIX}/prepared/v2/${SHA}/w320.webp`, `private/${PREFIX}/prepared/v2/${SHA}/w320.webp.receipt.json`];
// Neighbours that must survive: another file, a name that merely extends this one, live files, another site.
const BYSTANDERS = [`${PREFIX}/8c55699e81223005-190249_n.jpg`, `${BASE}.png`, `${PREFIX}/live/630c00d43ea74e18-${NAME}`, `media/othersite00/630c00d43ea74e18-${NAME}`, `${PREFIX}/site-logo.png`];

interface Fake { public: Set<string>; private: Set<string>; removed: string[]; purged: Map<string, string[]>; purge: (host: string) => Promise<void>; failRemove: Set<string> }
let fake: Fake;

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), { name: 'Moveria', media_id: 'spyuth63gr', created_at: '2026-01-01T00:00:00.000Z' });
  const { organizationDomainConfigPath, siteDomainConfigPath } = await import('../../lib/publishing/domain-config');
  await store.setDoc(organizationDomainConfigPath(ORG), { revision: 'r', default_domain: null, sites_domain: 'sites.moveria.com', media_host: ORG_HOST, dns_mode: 'automatic', verified_at: null });
  await store.setDoc(siteDomainConfigPath(ORG, SITE), { revision: 'r', dns_mode: 'automatic', state: 'live', media_aliases: [],
    desired: { website_host: 'moveria.fi', media_host: SITE_HOST, media_path_prefix: '' }, active: { website_host: 'moveria.fi', media_host: SITE_HOST, media_path_prefix: '' } });
  fake = { public: new Set([...COPIES, SITE_KEY, SITE_KEY + variant('original', 'webp'), ...BYSTANDERS]), private: new Set([ORIGINAL, ...PREPARED]),
    removed: [], purged: new Map(), purge: async () => {}, failRemove: new Set() };
  const { publicCopyRuntime } = await import('../../lib/media/public-copies');
  publicCopyRuntime.storage = async () => ({
    public_bucket: 'moveria-public', original_bucket: 'moveria-private',
    list: async (bucket, prefix) => [...(bucket === 'moveria-public' ? fake.public : fake.private)].filter(key => key.startsWith(prefix)),
    remove: async (bucket, key) => {
      if (fake.failRemove.has(key)) throw new Error('R2 unavailable');
      (bucket === 'moveria-public' ? fake.public : fake.private).delete(key); fake.removed.push(key);
    },
  });
  publicCopyRuntime.purger = async (_org, _site, host) => {
    await fake.purge(host);
    return { purge: async urls => { fake.purged.set(host, [...fake.purged.get(host) ?? [], ...urls]); } };
  };
  // The record's own private objects go through the storage client of their location.
  vi.doMock('../../lib/publishing/media-storage', () => ({
    storageClient: async () => ({ send: async (command: { input: { Key: string } }) => { fake.private.delete(command.input.Key); fake.removed.push(command.input.Key); } }),
  }));
  return store;
}

function record(over: Partial<Media> = {}): Media {
  return {
    id: 'photo', filename: NAME, sha256: SHA, mime_type: 'image/jpeg', created_at: '2026-01-01T00:00:00.000Z',
    cdn_url: `https://portal.example.test/api/sites/${SITE}/media/photo/content`,
    storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'moveria-private', key: ORIGINAL, generation: '1', state: 'ready', grant_expires_at: '' },
    published_url: `https://${ORG_HOST}/${BASE}`,
    // What recordPublishedMedia appends: every served address, original source included.
    source_aliases: ['https://moveria.fi/wp-content/uploads/2014/01/' + NAME, `https://${ORG_HOST}/${BASE}`, `https://${ORG_HOST}/${BASE}${variant('w320', 'webp')}`,
      `https://${SITE_HOST}/images/630c00d43ea74e18-${NAME}`],
    ...over,
  };
}

beforeEach(() => { vi.resetModules(); });

describe('deleting a media item', () => {
  it('removes every published copy on every media host key and purges each URL on every media host', async () => {
    const store = await setup();
    await store.setDoc(`${paths.media(ORG, SITE)}/photo`, record());
    const { deleteMediaItem } = await import('../../lib/media-deletion');
    const outcome = (await deleteMediaItem(ORG, SITE, 'photo'))!;

    expect(outcome.status).toBe(200);
    expect(await store.getDoc(`${paths.media(ORG, SITE)}/photo`)).toBeNull();
    for (const key of [...COPIES, SITE_KEY, SITE_KEY + variant('original', 'webp'), ORIGINAL, ...PREPARED]) expect(fake.removed).toContain(key);
    for (const key of BYSTANDERS) expect(fake.public.has(key)).toBe(true);
    const copies = outcome.body.public_copies as any;
    expect(copies.removed).toHaveLength(COPIES.length + 2);
    expect(copies.failed).toEqual([]);
    expect(copies.purge_unavailable).toEqual([]);
    // Each removed key is purged where it is served: /<key> on the shared host, /<key minus prefix> on the site host.
    expect(fake.purged.get(ORG_HOST)).toContain(`https://${ORG_HOST}/${BASE}${variant('original', 'avif')}`);
    expect(fake.purged.get(SITE_HOST)).toContain(`https://${SITE_HOST}/630c00d43ea74e18-${NAME}`);
    expect(fake.purged.get(SITE_HOST)).toContain(`https://${SITE_HOST}/images/630c00d43ea74e18-${NAME}`);
    expect(Math.max(...[...fake.purged.values()].map(list => list.length))).toBeGreaterThan(0);
    const tombstone = await store.getDoc<any>(`${paths.site(ORG, SITE)}/media_removals/photo`);
    expect(tombstone).toMatchObject({ state: 'complete', unpurged_urls: [], identity: { id: 'photo', sha256: SHA } });
  });

  it('keeps objects another record still uses: the same file imported twice publishes once', async () => {
    const store = await setup();
    await store.setDoc(`${paths.media(ORG, SITE)}/photo`, record());
    await store.setDoc(`${paths.media(ORG, SITE)}/twin`, record({ id: 'twin', cdn_url: `https://portal.example.test/api/sites/${SITE}/media/twin/content` }));
    const { deleteMediaItem } = await import('../../lib/media-deletion');
    const outcome = (await deleteMediaItem(ORG, SITE, 'photo'))!;

    expect(fake.removed).toEqual([]);
    expect((outcome.body.public_copies as any).protected).toContainEqual({ key: BASE, referenced_by: 'twin' });
    expect((outcome.body.private_objects as any).kept).toEqual([{ key: ORIGINAL, source: 'storage', referenced_by: 'twin' }]);
    expect((outcome.body.private_copies as any).protected.map((entry: any) => entry.key)).toEqual(PREPARED);
    expect(await store.getDoc(`${paths.media(ORG, SITE)}/twin`)).not.toBeNull();
  });

  it('reports a missing Cache Purge permission, keeps the tombstone pending and finishes on retry', async () => {
    const store = await setup();
    await store.setDoc(`${paths.media(ORG, SITE)}/photo`, record());
    const { ProviderError } = await import('../../lib/publishing/providers.mjs');
    fake.purge = async () => { throw new ProviderError('Cloudflare', 403); };
    const { deleteMediaItem, removePublishedMediaCopies } = await import('../../lib/media-deletion');
    const outcome = (await deleteMediaItem(ORG, SITE, 'photo'))!;

    expect(outcome.status).toBe(207);
    expect(fake.public.has(BASE)).toBe(false);
    const copies = outcome.body.public_copies as any;
    expect(copies.purge_unavailable.map((entry: any) => [entry.host, entry.code])).toEqual([[ORG_HOST, 'cache_purge_permission_required'], [SITE_HOST, 'cache_purge_permission_required']]);
    expect(copies.purge_unavailable[0].message).toContain('Cache Purge');
    expect((outcome.body.warnings as string[]).some(warning => warning.includes('remove_published_media_copies'))).toBe(true);
    const pending = await store.getDoc<any>(`${paths.site(ORG, SITE)}/media_removals/photo`);
    expect(pending.state).toBe('pending');
    expect(pending.unpurged_urls).toContain(`https://${ORG_HOST}/${BASE}`);

    // Permission granted: the objects are gone, so only the recorded URLs are purged.
    fake.purge = async () => {};
    const retry = await removePublishedMediaCopies(ORG, SITE, { media_ids: ['photo'] });
    expect(retry.status).toBe(200);
    expect(fake.purged.get(ORG_HOST)).toContain(`https://${ORG_HOST}/${BASE}`);
    expect(await store.getDoc<any>(`${paths.site(ORG, SITE)}/media_removals/photo`)).toMatchObject({ state: 'complete', unpurged_urls: [] });
  });

  it('reports an object that could not be removed and keeps the cleanup retryable', async () => {
    const store = await setup();
    await store.setDoc(`${paths.media(ORG, SITE)}/photo`, record());
    fake.failRemove.add(BASE);
    const { deleteMediaItem, removePublishedMediaCopies } = await import('../../lib/media-deletion');
    const outcome = (await deleteMediaItem(ORG, SITE, 'photo'))!;
    expect(outcome.status).toBe(207);
    expect((outcome.body.public_copies as any).failed).toEqual([{ key: BASE, reason: 'R2 unavailable' }]);
    expect(fake.purged.get(ORG_HOST) ?? []).not.toContain(`https://${ORG_HOST}/${BASE}`);

    fake.failRemove.clear();
    const retry = await removePublishedMediaCopies(ORG, SITE, { media_ids: ['photo'] });
    expect(retry.status).toBe(200);
    expect(fake.public.has(BASE)).toBe(false);
    expect(fake.purged.get(ORG_HOST)).toContain(`https://${ORG_HOST}/${BASE}`);
  });

  it('warns about redirects and content that still point at the file, without changing them', async () => {
    const store = await setup();
    await store.setDoc(`${paths.media(ORG, SITE)}/photo`, record());
    await store.setDoc(`${paths.redirects(ORG, SITE)}/wp-upload`, { from_path: `/wp-content/uploads/2014/01/${NAME}`, to_path: `https://${ORG_HOST}/${BASE}`, status_code: 301 });
    await store.setDoc(`${paths.redirects(ORG, SITE)}/unrelated`, { from_path: '/old', to_path: '/new', status_code: 301 });
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/team`, { title: 'Team', slug: 'team', html_content: `<img src="https://${ORG_HOST}/${BASE}${variant('w320', 'webp')}">` });
    const { deleteMediaItem } = await import('../../lib/media-deletion');
    const outcome = (await deleteMediaItem(ORG, SITE, 'photo'))!;
    const references = outcome.body.references as any;
    expect(references.redirects.map((rule: any) => rule.id)).toEqual(['wp-upload']);
    expect(references.content).toEqual([{ kind: 'page', id: 'team', title: 'Team' }]);
    const warnings = (outcome.body.warnings as string[]).join('\n');
    expect(warnings).toContain('wp-upload');
    expect(warnings).toContain('until the next publication');
    expect(await store.getDoc(`${paths.redirects(ORG, SITE)}/wp-upload`)).not.toBeNull();
  });
});

describe('removing copies of already-deleted media', () => {
  async function publish(store: Awaited<ReturnType<typeof setup>>, entries: any[]) {
    const { saveSnapshot } = await import('../../lib/publishing/publication-snapshot');
    const reference = await saveSnapshot({ orgId: ORG, siteId: SITE, jobId: 'job-1' }, { publication_id: 'p1', media_manifest: {
      delivery: 'r2', account_id: 'a'.repeat(32), original_bucket: 'moveria-private', public_bucket: 'moveria-public', site_prefix: PREFIX,
      media_host: ORG_HOST, website_host: 'moveria.fi', media_path_prefix: `/${PREFIX}`, entries } });
    await store.setDoc(paths.deploy(ORG, SITE, 'job-1'), { status: 'succeeded', created_at: '2026-11-01T00:00:00.000Z', git_publication: { snapshot_job_id: 'job-1', ...reference } });
  }
  const entry = { id: 'deleted-photo', sha256: SHA, source_key: ORIGINAL, public_key: BASE, cdn_url: `https://${ORG_HOST}/${BASE}`, public_path: `/${BASE}`,
    aliases: [{ url: `https://${SITE_HOST}/images/630c00d43ea74e18-${NAME}`, key: SITE_KEY }] };

  it('finds copies by media id in publication manifests; a dry run removes nothing; a second run is a no-op', async () => {
    const store = await setup();
    await publish(store, [entry]);
    const { removePublishedMediaCopies } = await import('../../lib/media-deletion');

    const dry = await removePublishedMediaCopies(ORG, SITE, { media_ids: ['deleted-photo'], dry_run: true });
    expect(dry.status).toBe(200);
    expect(fake.removed).toEqual([]);
    expect(fake.purged.size).toBe(0);
    expect(dry.body.media).toEqual([{ media_id: 'deleted-photo', status: 'found', found_in: ['publications'] }]);
    expect(new Set((dry.body.public_copies as any).would_remove)).toEqual(new Set([...COPIES, SITE_KEY, SITE_KEY + variant('original', 'webp')]));
    expect(new Set((dry.body.private_copies as any).would_remove)).toEqual(new Set([ORIGINAL, ...PREPARED]));
    expect(dry.body.publications).toEqual({ scanned: 1, unreadable: 0, skipped: 0 });

    const applied = await removePublishedMediaCopies(ORG, SITE, { media_ids: ['deleted-photo'] });
    expect(applied.status).toBe(200);
    expect(new Set((applied.body.public_copies as any).removed)).toEqual(new Set((dry.body.public_copies as any).would_remove));
    for (const key of BYSTANDERS) expect(fake.public.has(key)).toBe(true);
    expect(fake.private.size).toBe(0);
    expect(fake.purged.get(ORG_HOST)).toContain(`https://${ORG_HOST}/${BASE}`);
    expect(await store.getDoc<any>(`${paths.site(ORG, SITE)}/media_removals/deleted-photo`)).toMatchObject({ state: 'complete' });

    fake.removed = [];
    const again = await removePublishedMediaCopies(ORG, SITE, { media_ids: ['deleted-photo'] });
    expect(again.status).toBe(200);
    expect(fake.removed).toEqual([]);
    expect((again.body.public_copies as any).removed).toEqual([]);
  });

  it('removes copies referenced only by publications, never ones an existing record uses', async () => {
    const store = await setup();
    // A live record with the same bytes and name shares the copies.
    await store.setDoc(`${paths.media(ORG, SITE)}/twin`, record({ id: 'twin' }));
    await publish(store, [entry]);
    const { removePublishedMediaCopies } = await import('../../lib/media-deletion');
    const outcome = await removePublishedMediaCopies(ORG, SITE, { media_ids: ['deleted-photo', 'twin'], urls: [`https://${ORG_HOST}/${BASE}`] });
    expect(fake.removed).toEqual([]);
    expect((outcome.body.media as any[]).find(item => item.media_id === 'twin')).toMatchObject({ status: 'refused', code: 'media_exists' });
    expect((outcome.body.urls as any[])[0]).toMatchObject({ status: 'protected', referenced_by: 'twin' });
  });

  it('protects existing records on media hosts it learns only from publications', async () => {
    const store = await setup();
    // No media host configured any more: the host is known from the manifest alone.
    const { organizationDomainConfigPath, siteDomainConfigPath } = await import('../../lib/publishing/domain-config');
    await store.updateDoc(organizationDomainConfigPath(ORG), { media_host: null });
    await store.updateDoc(siteDomainConfigPath(ORG, SITE), { desired: { website_host: 'moveria.fi', media_host: null, media_path_prefix: '' }, active: null });
    await store.setDoc(`${paths.media(ORG, SITE)}/twin`, record({ id: 'twin', source_aliases: [] }));
    await publish(store, [entry]);
    const { removePublishedMediaCopies } = await import('../../lib/media-deletion');
    const outcome = await removePublishedMediaCopies(ORG, SITE, { media_ids: ['deleted-photo'] });
    expect(outcome.body.media_hosts).toEqual([ORG_HOST, SITE_HOST]);
    expect(fake.public.has(BASE)).toBe(true);
    expect((outcome.body.public_copies as any).protected).toContainEqual({ key: BASE, referenced_by: 'twin' });
  });

  it('removes exact URLs on this site\'s media hosts and refuses everything else', async () => {
    const store = await setup();
    await store.setDoc(`${paths.media(ORG, SITE)}/other`, record({ id: 'other', sha256: '8c55699e81223005' + 'c'.repeat(48), filename: '190249_n.jpg',
      published_url: `https://${ORG_HOST}/${BYSTANDERS[0]}`, source_aliases: [], storage: undefined }));
    const { removePublishedMediaCopies } = await import('../../lib/media-deletion');
    const target = `https://${ORG_HOST}/${BASE}${variant('original', 'webp')}`;
    const urls = [target, `https://${ORG_HOST}/${PREFIX}/0000000000000000-missing.jpg`,
      `https://evil.example.test/${BASE}`, `https://${ORG_HOST}/media/othersite00/630c00d43ea74e18-${NAME}`,
      `https://${ORG_HOST}/${PREFIX}/live/630c00d43ea74e18-${NAME}`, `https://${ORG_HOST}/${PREFIX}/site-logo.png`,
      `https://${ORG_HOST}/${BYSTANDERS[0]}`, `https://moveria.fi/media/630c00d43ea74e18-${NAME}`, `https://${ORG_HOST}/${BASE}?v=1`];

    const dry = await removePublishedMediaCopies(ORG, SITE, { urls, dry_run: true });
    expect(fake.removed).toEqual([]);
    expect((dry.body.urls as any[]).find(item => item.url === target)).toMatchObject({ status: 'would_remove', key: BASE + variant('original', 'webp') });

    const outcome = await removePublishedMediaCopies(ORG, SITE, { urls });
    const status = Object.fromEntries((outcome.body.urls as any[]).map(item => [item.url, item.code ?? item.status]));
    expect(status).toEqual({
      [target]: 'removed',
      [urls[1]!]: 'absent',
      [urls[2]!]: 'foreign_host',
      [urls[3]!]: 'foreign_prefix',
      [urls[4]!]: 'reserved_path',
      [urls[5]!]: 'not_a_media_copy',
      [urls[6]!]: 'protected',
      [urls[7]!]: 'foreign_host',
      [urls[8]!]: 'invalid_url',
    });
    expect(fake.removed).toEqual([BASE + variant('original', 'webp')]);
    for (const key of [BASE, ...BYSTANDERS]) expect(fake.public.has(key)).toBe(true);
    // Explicit URLs are purged even when already absent, so a retry clears the cache too.
    expect(fake.purged.get(ORG_HOST)).toEqual(expect.arrayContaining([target, urls[1]]));
    expect(fake.purged.get(ORG_HOST)).not.toContain(urls[6]);
  });

  it('reports a zone the connection cannot reach as purge_unavailable', async () => {
    await setup();
    const { ConnectionError } = await import('../../lib/publishing/connections');
    fake.purge = async () => { throw new ConnectionError('not in zone', 409, 'domain_zone_required'); };
    const { removePublishedMediaCopies } = await import('../../lib/media-deletion');
    const outcome = await removePublishedMediaCopies(ORG, SITE, { urls: [`https://${ORG_HOST}/${BASE}`] });
    expect(outcome.status).toBe(207);
    expect((outcome.body.public_copies as any).removed).toEqual([BASE]);
    expect((outcome.body.public_copies as any).purge_unavailable.map((entry: any) => [entry.host, entry.code])).toEqual([[ORG_HOST, 'cache_zone_unavailable'], [SITE_HOST, 'cache_zone_unavailable']]);
  });

  it('validates its input', async () => {
    await setup();
    const { removePublishedMediaCopies } = await import('../../lib/media-deletion');
    await expect(removePublishedMediaCopies(ORG, SITE, {})).rejects.toMatchObject({ code: 'removal_target_required' });
    await expect(removePublishedMediaCopies(ORG, SITE, { media_ids: ['../x'] })).rejects.toMatchObject({ code: 'invalid_media_ids' });
    await expect(removePublishedMediaCopies(ORG, SITE, { urls: 'https://x' })).rejects.toMatchObject({ code: 'invalid_urls' });
  });
});

describe('media API routes', () => {
  async function call(route: Promise<Partial<Record<string, APIRoute>>>, method: string, url: string, params: Record<string, string>, token: string, body?: unknown) {
    const handler = (await route)[method]!;
    const request = new Request(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return handler({ request, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
  }

  it('DELETE removes the published copies and POST published-copies removes them by URL', async () => {
    const store = await setup();
    await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: '2026-01-01T00:00:00.000Z' });
    await store.setDoc(`${paths.media(ORG, SITE)}/photo`, record());
    const { createApiKey } = await import('../../lib/api-keys');
    const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com' });

    const deleted = await call(import('../../pages/api/v1/sites/[siteId]/media/[mediaId]'), 'DELETE', `https://portal.example.test/api/v1/sites/${SITE}/media/photo`, { siteId: SITE, mediaId: 'photo' }, token);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).public_copies.removed).toContain(BASE);
    expect(fake.public.has(BASE)).toBe(false);

    const removal = await call(import('../../pages/api/v1/sites/[siteId]/media/published-copies'), 'POST', `https://portal.example.test/api/v1/sites/${SITE}/media/published-copies`, { siteId: SITE }, token,
      { urls: [`https://${ORG_HOST}/${BYSTANDERS[0]}`], dry_run: true });
    expect(removal.status).toBe(200);
    expect((await removal.json()).urls[0]).toMatchObject({ status: 'would_remove' });
  });
});

describe('listing a bucket prefix', () => {
  it('follows continuation tokens, decodes keys and reports a refused listing', async () => {
    const { listKeys } = await import('../../lib/media/public-copies');
    const requests: string[] = [];
    const pages = [
      '<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>media/a/x.jpg</Key></Contents><Contents><Key>media/a/x&amp;y.jpg</Key></Contents><NextContinuationToken>t&amp;2</NextContinuationToken></ListBucketResult>',
      '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>media/a/x.jpg.v2.original.0123456789abcdef.webp</Key></Contents></ListBucketResult>',
    ];
    const aws = { fetch: async (url: string) => { requests.push(url); return new Response(pages[requests.length - 1]!, { status: 200 }); } };
    expect(await listKeys(aws as any, new URL('https://acct.r2.cloudflarestorage.com/bucket/'), 'media/a/x')).toEqual(['media/a/x.jpg', 'media/a/x&y.jpg', 'media/a/x.jpg.v2.original.0123456789abcdef.webp']);
    expect(new URL(requests[0]!).pathname).toBe('/bucket');
    expect(new URL(requests[0]!).searchParams.get('prefix')).toBe('media/a/x');
    expect(new URL(requests[1]!).searchParams.get('continuation-token')).toBe('t&2');
    const denied = { fetch: async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }) };
    await expect(listKeys(denied as any, new URL('https://acct.r2.cloudflarestorage.com/bucket/'), 'media/a/')).rejects.toThrow('AccessDenied');
  });
});
