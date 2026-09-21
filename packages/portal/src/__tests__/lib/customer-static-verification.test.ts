import { beforeEach, expect, it, vi } from 'vitest';
import { staticControlsHash, changedStaticChecks, selectStaticProbes, publicStaticChecks, verifyCandidateBatch, verifyCandidateCheck, verifyResponseBody, PROBE_BYTES, PROBE_FILES } from '../../lib/builds/static-verifier.mjs';
import { sha256, BUILD_PROTOCOL, BUILD_RUNTIME } from '../../lib/builds/contract.mjs';
import { OrganizationBuildQueue } from '../../lib/builds/queue';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { saveCustomerVerification } from '../../lib/builds/publication';
const storage = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('../../lib/builds/storage', () => ({ buildStorage: async (_org: string, work: any) => work({
  read: async (key: string) => { if (!storage.has(key)) throw Error('missing'); return storage.get(key)!; },
  put: async (key: string, bytes: Buffer) => { storage.set(key, bytes); },
}) }));

const origin = 'https://abc123.fixture.pages.dev';
const check = (route: string, body = 'verified') => ({ route, status: 200 as const, sha256: sha256(body), size: Buffer.byteLength(body) });
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

it('reuses verified checks only with unchanged account, project, domains and control files', async () => {
  const before = [check('/media/image.jpg'), check('/', 'old')];
  const current = [...before.slice(0, 1), check('/', 'new'), check('/.well-known/typeroll/publication.json')];
  storage.set('previous', Buffer.from(JSON.stringify(before)));
  storage.set('current', Buffer.from(JSON.stringify(current)));
  const scope = { account_id: 'account', project: 'project', website_host: 'site.example.com', domain_revision: 'domain-1' };
  const controls = { _headers: Buffer.from('/*\n X-Robots-Tag: noindex').toString('base64') };
  const direct = { format: 1 as const, files: {}, manifest: {}, controls };
  const previous = { ...scope, static_checks_key: 'previous', static_controls_sha256: staticControlsHash(controls) };
  const baseline = { ...scope, static_checks_key: 'current' };
  const reused = await saveCustomerVerification('org', baseline, direct, previous);
  expect(JSON.parse(storage.get(reused.verification_checks_key)!.toString()).map((c: any) => c.route)).toEqual(['/', '/.well-known/typeroll/publication.json']);
  for (const field of ['account_id', 'project', 'website_host', 'domain_revision']) {
    const changed = await saveCustomerVerification('org', { ...baseline, [field]: 'changed' }, direct, previous);
    expect(JSON.parse(storage.get(changed.verification_checks_key)!.toString())).toHaveLength(3);
  }
  for (const prior of [undefined, { ...previous, static_controls_sha256: 'changed' }]) {
    const changed = await saveCustomerVerification('org', baseline, direct, prior);
    expect(JSON.parse(storage.get(changed.verification_checks_key)!.toString())).toHaveLength(3);
  }
});

it('keeps a thousand unchanged images out of both worker downloads and coordinator probes', async () => {
  const images = Array.from({ length: 1000 }, (_, i) => check(`/media/${i}.jpg`, 'image'));
  const before = [check('/', 'old title'), ...images];
  const current = [check('/', 'new title'), check('/.well-known/typeroll/publication.json', 'new publication'), ...images];
  const changed = changedStaticChecks(current, before, true);
  expect(changed.map(x => x.route)).toEqual(['/', '/.well-known/typeroll/publication.json']);
  expect(selectStaticProbes(current, changed).some(x => x.route.startsWith('/media/'))).toBe(false);
  const fetchImpl = vi.fn(async (url: URL | RequestInfo) => new Response(String(url).endsWith('publication.json') ? 'new publication' : 'new title'));
  expect(await verifyCandidateBatch({ origin, checks: changed }, 0, { fetchImpl })).toEqual({ cursor: 2, total: 2 });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(changedStaticChecks(current, before, false)).toHaveLength(1002);
});

it('bounds portal probes independently of library size and retains small page and removal checks', () => {
  const checks = [check('/.well-known/typeroll/publication.json'), check('/'), check('/robots.txt'), check('/sitemap.xml'),
    { route: '/removed/', status: 404 as const }, ...Array.from({ length: 10000 }, (_, i) => ({ ...check(`/large-${i}.jpg`), size: 18 * 1024 * 1024 })),
    ...Array.from({ length: 100 }, (_, i) => ({ ...check(`/small-${i}.html`), size: 200000 }))];
  const probes = selectStaticProbes(checks);
  expect(probes.length).toBeLessThanOrEqual(PROBE_FILES);
  expect(probes.reduce((n, c) => n + (c.size ?? 0), 0)).toBeLessThanOrEqual(PROBE_BYTES);
  expect(probes.some(c => c.route === '/removed/')).toBe(true);
  expect(probes.some(c => c.route.startsWith('/large-'))).toBe(false);
});

it('hashes an 18 MiB response incrementally without collecting it into another full-size buffer', async () => {
  const chunk = Buffer.alloc(65536, 7), count = 288;
  const { createHash } = await import('node:crypto'); const hash = createHash('sha256');
  for (let i = 0; i < count; i++) hash.update(chunk);
  let sent = 0, observed = 0;
  const response = new Response(new ReadableStream({ pull(controller) { if (sent++ < count) controller.enqueue(chunk); else controller.close(); } }));
  const concat = vi.spyOn(Buffer, 'concat');
  try {
    expect(await verifyResponseBody(response, { route: '/large.pdf', status: 200, sha256: hash.digest('hex') }, undefined, n => { observed += n; })).toBe(true);
    expect(observed).toBe(18 * 1024 * 1024); expect(concat).not.toHaveBeenCalled();
  } finally { concat.mockRestore(); }
});

it('rejects stale files, external redirects and incomplete sibling groups', async () => {
  const fetchImpl = vi.fn(async (url: URL | RequestInfo) => new Response(String(url).endsWith('/bad') ? 'stale' : 'verified'));
  await expect(verifyCandidateBatch({ origin, checks: [check('/good'), check('/bad'), check('/sibling')] }, 0, { fetchImpl })).rejects.toThrow('static_verification_pending');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  fetchImpl.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }));
  expect(await verifyCandidateCheck(origin, check('/'), { fetchImpl })).toBe(false);
  await expect(verifyCandidateCheck('https://other.example.com', check('/'), { fetchImpl })).rejects.toThrow('invalid_verification_origin');
});

it('gives verification its own identity and resumes checkpoints without rebuilding the publication', async () => {
  const identity = { org_id: 'org', site_id: 'site', version_id: 'main', job_id: 'job', publication_id: 'b'.repeat(64), commit: 'c'.repeat(40), branch: 'main', protocol: BUILD_PROTOCOL, node_version: BUILD_RUNTIME, source_sha256: 'a'.repeat(64) };
  let now = Date.now(); const queue = new OrganizationBuildQueue(undefined, () => now);
  const build = await queue.enqueue(identity, 'engine', 0);
  const first = (await queue.claim('org', 'engine', 1))!;
  await queue.complete('org', build.key, first.lease_id, first.token, { sha256: 'd'.repeat(64), key: `builds/org/tasks/${build.key}/${first.lease_id}/artifact.json` });
  const verification = await queue.enqueue({ ...identity, source_sha256: 'e'.repeat(64) }, 'engine', 150, 'static_verification');
  expect(verification.key).not.toBe(build.key);
  const claim = (await queue.claim('org', 'engine', 1))!;
  await queue.checkpointMedia('org', claim.key, claim.lease_id, claim.token, 100);
  await expect(queue.authorize('org', claim.key, claim.lease_id, claim.token)).rejects.toThrow();
  now += 1000;
  const next = (await queue.claim('org', 'engine', 1))!;
  expect(next).toMatchObject({ key: verification.key, media_cursor: 100, media_total: 150 });
  await queue.checkpointMedia('org', next.key, next.lease_id, next.token, 150, true);
  await queue.complete('org', next.key, next.lease_id, next.token, { sha256: 'f'.repeat(64), key: `builds/org/tasks/${next.key}/${next.lease_id}/artifact.json` });
  expect(await queue.claim('org', 'engine', 1)).toBeNull();
});

it('ignores only the generated publication header when comparing control-file behavior', () => {
  const controls = (id: string, robots = 'noindex') => ({ _headers: Buffer.from(`/*\n  X-Typeroll-Publication: ${id}\n  X-Robots-Tag: ${robots}\n`).toString('base64') });
  expect(staticControlsHash(controls('a'.repeat(64)))).toBe(staticControlsHash(controls('b'.repeat(64))));
  expect(staticControlsHash(controls('a'.repeat(64)))).not.toBe(staticControlsHash(controls('b'.repeat(64), 'index')));
  expect(staticControlsHash(controls('a'.repeat(64)))).not.toBe(staticControlsHash({ ...controls('a'.repeat(64)), _redirects: Buffer.from('/old /new 301').toString('base64') }));
});

it('allows retired immutable bundles only on public hosts, retaining all candidate removal checks', async () => {
  const retired = [
    '/_assets/extensions/se.example.widget/0.2.2/lead-form/index.css',
    '/_assets/extensions/se.example.widget/0.2.2/lead-form/index.js',
    '/_astro/index.D4ff2xqW.css',
  ].map(route => ({ route, status: 404 as const }));
  const required = [
    '/removed/', '/media/photo.jpg', '/uploads/private.pdf', '/style.css',
    '/_assets/photo.jpg', '/_assets/extensions/se.example.widget/latest/lead-form/index.css',
    '/_assets/extensions/se.example.widget/0.2.2/lead-form/index.html', '/_astro/index.css',
  ].map(route => ({ route, status: 404 as const }));
  const current = [check('/.well-known/typeroll/publication.json'), check('/'),
    check('/_assets/extensions/se.example.widget/0.2.3/lead-form/index.css')];
  const checks = [...current, ...retired, ...required];
  expect(publicStaticChecks(checks)).toEqual([...current, ...required]);
  expect(selectStaticProbes(checks).filter(c => c.status === 404)).toHaveLength(required.length);
  expect(changedStaticChecks(checks, [], true)).toEqual(checks);
  const fetchImpl = vi.fn(async () => new Response('retained old CSS', { status: 200 }));
  expect(await verifyCandidateCheck(origin, retired[0], { fetchImpl })).toBe(false);
  fetchImpl.mockImplementation(async () => new Response(null, { status: 404 }));
  expect(await verifyCandidateCheck(origin, retired[0], { fetchImpl })).toBe(true);
});


it('allows old native media variants only while their exact source remains in the artifact', async () => {
  const source = check('/media/photo.jpg', 'original image');
  const variant = (suffix: string) => ({ route: `${source.route}.${suffix}`, status: 404 as const });
  const old = variant(`v1.w640.${source.sha256.slice(0, 16)}.avif`);
  const full = variant(`v2.original.${source.sha256.slice(0, 16)}.webp`);
  const current = check(`/media/photo.jpg.v2.w320.${source.sha256.slice(0, 16)}.avif`);
  expect(publicStaticChecks([source, old, full, current])).toEqual([source, current]);
  expect(publicStaticChecks([old], [source])).toEqual([]);
  expect(publicStaticChecks([old], [])).toEqual([old]);
  expect(publicStaticChecks([old], [check(source.route, 'replacement image')])).toEqual([old]);
  for (const suffix of ['v1.w640.not-a-hash.avif', `v1.w640.${source.sha256.slice(0, 16)}.avif?x=1`, `v1.original.${source.sha256.slice(0, 16)}.jpg`]) {
    const required = variant(suffix);
    expect(publicStaticChecks([required], [source])).toEqual([required]);
  }
  const removed = { route: source.route, status: 404 as const };
  expect(publicStaticChecks([removed, old])).toEqual([removed, old]);
  expect(selectStaticProbes([source, old, current], [old, current])).toEqual([current]);
  expect(changedStaticChecks([source, old], [source], true)).toEqual([old]);
  expect(await verifyCandidateCheck(origin, old, { fetchImpl: async () => new Response('old variant') })).toBe(false);
});
