import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { shareCopyTarget } from '../../../../../scripts/fixtures/static-publication/media-recipe.mjs';

// An isolated media host on a synthetic zone; no request leaves the test.
const state = vi.hoisted(() => ({ domains: new Map<string, any>(), rules: null as any[] | null, writes: [] as Array<{ path: string; body: any }>,
  organization: { media_host: null as string | null, dns_mode: 'automatic' as 'automatic' | 'external' }, responses: new Map<string, () => Response>() }));
vi.mock('../../lib/publishing/connections', async original => ({ ...await original<object>(),
  getConnection: vi.fn(async () => ({ cloudflare: { account_id: 'acct', public_bucket: 'public' }, revision: 'r1' })) }));
vi.mock('../../lib/publishing/domain-config', () => ({ getOrganizationDomains: vi.fn(async () => state.organization) }));
vi.mock('../../lib/publishing/domain-provider', () => ({ findPublishingZone: vi.fn(async () => ({ id: 'zone', name: 'example.test' })) }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: vi.fn(async () => async (path: string, options: any = {}) => {
  const domain = path.match(/\/domains\/custom\/(.+)$/)?.[1];
  if (options.method === 'POST') {
    state.writes.push({ path, body: options.body });
    if (path.endsWith('/domains/custom')) state.domains.set(options.body.domain, { domain: options.body.domain, enabled: true, zoneId: 'zone', status: { ownership: 'active', ssl: 'active' } });
    else if (path.endsWith('/rulesets')) state.rules = [...options.body.rules];
    else state.rules = [...state.rules ?? [], options.body];
    return { id: 'ruleset' };
  }
  if (domain) return state.domains.get(domain) ?? (options.missing ? null : Promise.reject(new Error('missing domain')));
  if (path.includes('/dns_records')) return [];
  if (path.endsWith('/entrypoint')) return state.rules ? { id: 'ruleset', rules: state.rules } : null;
  throw new Error(`unexpected ${path}`);
}) }));
vi.mock('../../lib/extensions/public-http', () => ({ parsePublicHttpsUrl: (url: string) => new URL(url) }));
vi.mock('../../lib/net/safe-fetch', () => ({ safeFetch: vi.fn(async (url: URL) => {
  const respond = state.responses.get(url.href);
  if (!respond) return new Response('missing', { status: 404 });
  return respond();
}) }));

import { preparePublicMediaDelivery, verifyPublicMediaDelivery, mediaDeliveryScope } from '../../lib/publishing/media-domain';
import { ConnectionError } from '../../lib/publishing/connections';
import { safeFetch } from '../../lib/net/safe-fetch';

const bytes = 'synthetic photo bytes';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const host = 'media.isolated-fixture.test';
const rule = (prefix: string) => ({ ref: `typeroll_media_${hash(host).slice(0, 16)}`, action: 'rewrite', enabled: true, description: 'Typeroll site media path', expression: `http.host eq "${host}"`,
  action_parameters: { uri: { path: { expression: `concat("/${prefix}", http.request.uri.path)` } } } });
function manifest(overrides: Record<string, unknown> = {}) {
  return { delivery: 'r2', account_id: 'acct', public_bucket: 'public', media_host: host, website_host: 'www.isolated-fixture.test', dns_mode: 'automatic' as const,
    site_prefix: 'media/site123', entries: [{ cdn_url: `https://${host}/photo.png`, sha256: hash(bytes), aliases: [] as Array<{ url: string; key?: string }>, public_key: 'media/site123/photo.png', mime_type: 'image/png' }], ...overrides };
}
const serve = (url: string, body: string | Uint8Array) => state.responses.set(url, () => new Response(typeof body === 'string' ? body : Buffer.from(body)));

beforeEach(() => {
  state.domains.clear(); state.rules = null; state.writes.length = 0; state.responses.clear();
  state.organization = { media_host: null, dns_mode: 'automatic' };
  vi.mocked(safeFetch).mockClear();
});

it('provisions a new site media host, its namespace rule, and proves the bytes', async () => {
  serve(`https://${host}/photo.png`, bytes);
  const result = await preparePublicMediaDelivery('org', manifest());
  expect(result).toMatchObject({ ready: true, checked: 1, scope: mediaDeliveryScope(manifest()) });
  expect(state.writes.map(write => write.path)).toEqual([
    '/accounts/acct/r2/buckets/public/domains/custom', '/zones/zone/rulesets']);
  expect(state.rules).toEqual([rule('media/site123')]);
});

it('finishes a partially failed provisioning without recreating what exists', async () => {
  // A first attempt created the R2 custom domain and stopped before the rule.
  state.domains.set(host, { domain: host, enabled: true, zoneId: 'zone', status: { ownership: 'active', ssl: 'active' } });
  state.rules = [{ ref: 'unrelated', expression: 'true', action_parameters: {} }];
  serve(`https://${host}/photo.png`, bytes);
  expect(await preparePublicMediaDelivery('org', manifest())).toMatchObject({ ready: true });
  expect(state.writes).toEqual([{ path: '/zones/zone/rulesets/ruleset/rules', body: rule('media/site123') }]);
  expect(state.rules?.[0].ref).toBe('unrelated');
});

it('leaves a working, manually repaired configuration untouched', async () => {
  state.domains.set(host, { domain: host, enabled: true, zoneId: 'zone', status: { ownership: 'active', ssl: 'active' } });
  state.rules = [rule('media/site123')];
  serve(`https://${host}/photo.png`, bytes);
  expect(await preparePublicMediaDelivery('org', manifest())).toMatchObject({ ready: true });
  expect(state.writes).toEqual([]);
});

it('reports missing public DNS instead of success', async () => {
  state.responses.set(`https://${host}/photo.png`, () => { throw Object.assign(new Error('Destination host could not be resolved'), { code: 'dns_failed' }); });
  const result = await preparePublicMediaDelivery('org', manifest());
  expect(result).toMatchObject({ ready: false, pending: { host, issue: 'dns_missing', url: `https://${host}/photo.png` } });
  expect(result.ready === false && result.pending.message).toContain(`${host} has no public DNS answer yet`);
});

it('waits for a pending certificate before any byte check', async () => {
  state.domains.set(host, { domain: host, enabled: true, zoneId: 'zone', status: { ownership: 'active', ssl: 'pending' } });
  state.rules = [rule('media/site123')];
  expect(await preparePublicMediaDelivery('org', manifest())).toMatchObject({ ready: false, pending: { host, issue: 'certificate_pending' } });
  expect(safeFetch).not.toHaveBeenCalled();
  // A TLS failure on the public request is reported the same way.
  state.domains.get(host).status.ssl = 'active';
  state.responses.set(`https://${host}/photo.png`, () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('certificate'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) }); });
  expect(await preparePublicMediaDelivery('org', manifest())).toMatchObject({ ready: false, pending: { issue: 'certificate_pending' } });
});

it('refuses a namespace rule for another prefix and names the rule when the host serves other bytes', async () => {
  state.domains.set(host, { domain: host, enabled: true, zoneId: 'zone', status: { ownership: 'active', ssl: 'active' } });
  state.rules = [rule('media/another-site')];
  await expect(preparePublicMediaDelivery('org', manifest())).rejects.toMatchObject({ code: 'media_path_rule_conflict' });
  expect(state.writes).toEqual([]);
  // Externally managed: Typeroll cannot read the rule, the bytes show it.
  serve(`https://${host}/photo.png`, 'another site photo');
  const result = await preparePublicMediaDelivery('org', manifest({ dns_mode: 'external' }));
  expect(result).toMatchObject({ ready: false, pending: { issue: 'wrong_bytes' } });
  expect(result.ready === false && result.pending.message).toContain('must prepend /media/site123');
});

it('reports a file the failed upload did not store', async () => {
  const result = await preparePublicMediaDelivery('org', manifest());
  expect(result).toMatchObject({ ready: false, pending: { issue: 'not_served', http_status: 404 } });
});

it('keeps proving retained addresses on the shared host after a switch to an own media host', async () => {
  state.organization = { media_host: 'media.shared-fixture.test', dns_mode: 'automatic' };
  state.domains.set('media.shared-fixture.test', { domain: 'media.shared-fixture.test', enabled: true, zoneId: 'zone', status: { ownership: 'active', ssl: 'active' } });
  const switched = manifest({ entries: [{ ...manifest().entries[0], aliases: [{ url: 'https://media.shared-fixture.test/media/site123/photo.png', key: 'media/site123/photo.png' }] }] });
  serve(`https://${host}/photo.png`, bytes);
  const pending = await preparePublicMediaDelivery('org', switched);
  expect(pending).toMatchObject({ ready: false, pending: { host: 'media.shared-fixture.test', issue: 'not_served' } });
  serve('https://media.shared-fixture.test/media/site123/photo.png', bytes);
  expect(await preparePublicMediaDelivery('org', switched)).toMatchObject({ ready: true, checked: 2 });
  // The receipt of the shared-host publication does not cover the own host.
  expect(mediaDeliveryScope(switched, 'media.shared-fixture.test')).not.toBe(mediaDeliveryScope(manifest({ media_host: 'media.shared-fixture.test' }), 'media.shared-fixture.test'));
});

it('proves stored share copies through the media host before pages may reference them', async () => {
  const shared = manifest({ share_background: '#102030', entries: [{ ...manifest().entries[0], share_source: true, mime_type: 'image/svg+xml' }] });
  const target = shareCopyTarget(shared, shared.entries[0])!;
  serve(`https://${host}/photo.png`, bytes);
  // No copy stored: nothing references one.
  expect(await verifyPublicMediaDelivery(shared)).toMatchObject({ ready: true, checked: 1 });
  const copy = new Uint8Array([1, 2, 3]);
  serve(target.receipt_url, JSON.stringify({ sha256: hash(copy) }));
  expect(await verifyPublicMediaDelivery(shared)).toMatchObject({ ready: false, pending: { url: target.url, issue: 'not_served' } });
  serve(target.url, new Uint8Array([9]));
  expect(await verifyPublicMediaDelivery(shared)).toMatchObject({ ready: false, pending: { url: target.url, issue: 'wrong_bytes' } });
  serve(target.url, copy);
  expect(await verifyPublicMediaDelivery(shared)).toMatchObject({ ready: true, checked: 2 });
  expect(target.url).toBe(`https://${host}/photo.png.share-s1.card.${hash(bytes).slice(0, 16)}.102030.png`);
});

it('keeps the connection guard', async () => {
  await expect(preparePublicMediaDelivery('org', manifest({ public_bucket: 'other' }))).rejects.toBeInstanceOf(ConnectionError);
});
