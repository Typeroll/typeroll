import { describe, expect, it, vi } from 'vitest';
import { staticChecks, staticManifestChecks, verifyStaticResponse, ProbeByteBudgetError } from '../../lib/builds/verification';
import { staticFailureMessage } from '../../lib/builds/publication';
import { sha256, assertFilePath } from '../../lib/builds/contract.mjs';
import { responseBytes, outputFiles } from '../../lib/builds/executor.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
it('verifies safe replacement bytes through a retired media redirect and rejects stale bytes', async () => {
  const files = { 'media/new.svg': Buffer.from('sanitized'), _redirects: Buffer.from('/media/old.svg /media/new.svg 301') };
  const checks = staticChecks(files, [{ route: '/media/old.svg', status: 200, sha256: sha256('unsafe') }]);
  const old = checks.find(check => check.route === '/media/old.svg')!;
  expect(old).toMatchObject({ status: 200, sha256: sha256('sanitized') });
  const validate = async () => undefined;
  expect(await verifyStaticResponse('https://site.example.invalid', old, { validate, fetchImpl: async () => new Response('unsafe') })).toBe(false);
  expect(await verifyStaticResponse('https://site.example.invalid', old, { validate, fetchImpl: async url => String(url).endsWith('/old.svg')
    ? new Response(null, { status: 301, headers: { location: '/media/new.svg' } }) : new Response('sanitized') })).toBe(true);
  expect(staticChecks({ 'index.html': Buffer.from('home') }, checks)).toContainEqual({ route: '/media/old.svg', status: 404 });
});
it('checks current pages and assets plus removed routes without treating headers as content', () => {
  const before = staticChecks({ 'index.html': Buffer.from('old'), 'removed/index.html': Buffer.from('gone'), 'moved/index.html': Buffer.from('redirect') });
  const checks = staticChecks({ 'index.html': Buffer.from('new'), 'image.png': Buffer.from('png'), _headers: Buffer.from('/*\n X-Robots-Tag: noindex'), _redirects: Buffer.from('/moved/ / 301') }, before);
  expect(checks).toEqual([{ route: '/', status: 200, sha256: sha256('new') }, { route: '/image.png', status: 200, sha256: sha256('png') }, { route: '/removed/', status: 404 }]);
});
it('rejects stale bodies and deleted pages even when publication headers are fresh', async () => {
  const fetchImpl = vi.fn(async () => new Response('old', { headers: { 'x-typeroll-publication': 'new' } }));
  const validate = vi.fn(async () => undefined);
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/', status: 200, sha256: sha256('new') }, { fetchImpl, validate })).toBe(false);
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/removed', status: 404 }, { fetchImpl, validate })).toBe(false);
  fetchImpl.mockImplementation(async () => new Response('new'));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/', status: 200, sha256: sha256('new') }, { fetchImpl, validate })).toBe(true);
  fetchImpl.mockImplementation(async () => new Response('gone', { status: 404 }));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/removed', status: 404 }, { fetchImpl, validate })).toBe(true);
});
it('does not follow redirects to another origin', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example.invalid/' } }));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/', status: 200, sha256: sha256('new') }, { fetchImpl, validate: async () => undefined })).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('accepts a Cloudflare managed robots prefix only when the original file remains byte-identical', async () => {
  const original = 'User-agent: *\nDisallow: /\n';
  const prefix = '# As a condition of accessing this website\n# BEGIN Cloudflare Managed content\nUser-agent: *\nContent-Signal: search=yes,ai-train=no\n# END Cloudflare Managed Content\n\n';
  const check = { route: '/robots.txt', status: 200 as const, sha256: sha256(original) };
  const fetchImpl = vi.fn(async () => new Response(prefix + original));
  const validate = async () => undefined;
  expect(await verifyStaticResponse('https://site.example.invalid', check, { fetchImpl, validate })).toBe(true);
  fetchImpl.mockImplementation(async () => new Response(prefix + 'User-agent: *\nAllow: /\n'));
  expect(await verifyStaticResponse('https://site.example.invalid', check, { fetchImpl, validate })).toBe(false);
  fetchImpl.mockImplementation(async () => new Response(prefix));
  expect(await verifyStaticResponse('https://site.example.invalid', check, { fetchImpl, validate })).toBe(false);
  fetchImpl.mockImplementation(async () => new Response(prefix + original));
  expect(await verifyStaticResponse('https://site.example.invalid', { ...check, route: '/other.txt' }, { fetchImpl, validate })).toBe(false);
  expect(await verifyStaticResponse('https://site.example.invalid', { ...check, status: 404 }, { fetchImpl, validate })).toBe(false);
});
it('bounds streamed transfers and rejects private output files', async () => {
  await expect(responseBytes(new Response('12345'), 4)).rejects.toThrow('limit');
  for (const name of ['.env', '.env.local', '.npmrc', 'functions/a.js', '_worker.js']) expect(() => assertFilePath(name, { artifact: true })).toThrow('private');
});
it('rejects symbolic links and hard links before collecting output', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'typeroll-artifact-test-'));
  try {
    await fs.writeFile(path.join(root, 'index.html'), 'site'); await fs.symlink('index.html', path.join(root, 'linked.html'));
    await expect(outputFiles(root)).rejects.toThrow('unsafe');
    await fs.unlink(path.join(root, 'linked.html')); await fs.link(path.join(root, 'index.html'), path.join(root, 'linked.html'));
    await expect(outputFiles(root)).rejects.toThrow('unsafe');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('reports status, content and network failures with bounded non-secret evidence', async () => {
  const observe = vi.fn();
  const fetchImpl = vi.fn(async () => new Response('private response body', { headers: { 'cf-ray': 'a38654d0f853c124-ARN', 'set-cookie': 'never-export' } }));
  const options = { fetchImpl, validate: async () => undefined, observe };
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/gone/', status: 404 }, options)).toBe(false);
  expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ route: '/gone/', expected_status: 404, actual_status: 200, reason: 'status_mismatch', cf_ray: 'a38654d0f853c124-ARN' }));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/', status: 200, sha256: sha256('new') }, options)).toBe(false);
  expect(observe.mock.lastCall?.[0].reason).toBe('content_mismatch');
  fetchImpl.mockRejectedValue(Error('secret provider payload'));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/', status: 200 }, options)).toBe(false);
  expect(observe.mock.lastCall?.[0]).toMatchObject({ actual_status: null, reason: 'request_failed' });
  expect(JSON.stringify(observe.mock.calls)).not.toMatch(/private response|never-export|secret provider/);
});

it('records safe headers and a body fingerprint for a removed route returning an old page', async () => {
  const observe = vi.fn();
  const body = 'private page content that must not enter diagnostics';
  const fetchImpl = vi.fn(async () => new Response(body, { headers: {
    'content-type': 'text/html; private=never-export', 'cache-control': 'public, max-age=0, custom=never-export',
    'cf-cache-status': 'DYNAMIC', age: '12', 'x-typeroll-publication': 'a'.repeat(64),
    'set-cookie': 'secret-cookie', 'x-debug-token': 'secret-token',
  } }));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/gone/', status: 404 }, { fetchImpl, validate: async () => {}, observe })).toBe(false);
  expect(observe.mock.lastCall?.[0]).toMatchObject({
    final_path: '/gone/', redirect_chain: [],
    response_headers: { content_type: 'text/html', cache_control: 'public, max-age=0', cf_cache_status: 'DYNAMIC', age: 12, publication_id: 'a'.repeat(64) },
    body_sample: { sha256: sha256(body), bytes: Buffer.byteLength(body), scope: 'complete' },
  });
  expect(JSON.stringify(observe.mock.calls)).not.toMatch(/private page|never-export|secret-cookie|secret-token/);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('records same-origin redirect paths without query values or fragments', async () => {
  const observe = vi.fn();
  const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: '/fallback/?token=secret#private' } }))
    .mockResolvedValueOnce(new Response('fallback'));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/gone/?key=hidden', status: 404 }, { fetchImpl, validate: async () => {}, observe })).toBe(false);
  expect(observe.mock.lastCall?.[0]).toMatchObject({ route: '/gone/', final_path: '/fallback/',
    redirect_chain: [{ status: 301, from_path: '/gone/', to_path: '/fallback/', same_origin: true }] });
  expect(JSON.stringify(observe.mock.calls)).not.toMatch(/secret|private|hidden|token|key=/);
});

it('does not fetch or disclose cross-origin redirect destinations', async () => {
  const observe = vi.fn();
  const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example.invalid/private-path?secret=yes' } }));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/gone/', status: 404 }, { fetchImpl, validate: async () => {}, observe })).toBe(false);
  expect(observe.mock.lastCall?.[0]).toMatchObject({ reason: 'redirect_offsite', final_path: '/gone/',
    redirect_chain: [{ status: 302, from_path: '/gone/', to_path: null, same_origin: false }] });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(observe.mock.calls)).not.toMatch(/other.example|private-path|secret/);
});

it('hashes at most 4096 body bytes and cancels a larger status-mismatch stream', async () => {
  const observe = vi.fn(), cancel = vi.fn(), observeBytes = vi.fn();
  let read = 0;
  const stream = new ReadableStream({ pull(controller) { read++; controller.enqueue(new Uint8Array(1024).fill(65)); }, cancel }, { highWaterMark: 0 });
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/gone/', status: 404 }, {
    fetchImpl: async () => new Response(stream), validate: async () => {}, observe, observeBytes,
  })).toBe(false);
  expect(read).toBe(4); expect(cancel).toHaveBeenCalledOnce();
  expect(observeBytes.mock.calls.reduce((sum, [n]) => sum + n, 0)).toBe(4096);
  expect(observe.mock.lastCall?.[0].body_sample).toEqual({ sha256: sha256(Buffer.alloc(4096, 65)), bytes: 4096, scope: 'prefix' });
});

it('collects content-mismatch fingerprints in the existing stream without a second request', async () => {
  const observe = vi.fn(), fetchImpl = vi.fn(async () => new Response('old content'));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/', status: 200, sha256: sha256('new content') }, { fetchImpl, validate: async () => {}, observe })).toBe(false);
  expect(observe.mock.lastCall?.[0]).toMatchObject({ reason: 'content_mismatch', body_sample: { sha256: sha256('old content'), bytes: 11, scope: 'complete' } });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('respects smaller sampling budgets and excludes unrecognized provider header values', async () => {
  const observe = vi.fn(), observeBytes = vi.fn();
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/gone/', status: 404 }, {
    fetchImpl: async () => new Response('123456789', { headers: {
      'cf-cache-status': 'private-secret', 'x-typeroll-publication': 'private-secret',
      'age': 'private-secret', 'content-length': 'private-secret', 'cf-ray': 'private-secret',
      'cache-control': 'private="secret-cookie", custom=private-secret', 'cf-mitigated': 'private-secret',
    } }), validate: async () => {}, observe, observeBytes, maxBytes: 3,
  })).toBe(false);
  expect(observe.mock.lastCall?.[0]).toMatchObject({ response_headers: {}, cf_ray: null,
    body_sample: { sha256: sha256('123'), bytes: 3, scope: 'prefix' } });
  expect(observeBytes).toHaveBeenCalledWith(9);
  expect(JSON.stringify(observe.mock.calls)).not.toMatch(/private-secret|secret-cookie/);
});

it('does not retain a previous hop status if the final request fails', async () => {
  const observe = vi.fn();
  const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: '/final/' } }))
    .mockRejectedValue(Error('secret transport details'));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/gone/', status: 404 }, { fetchImpl, validate: async () => {}, observe })).toBe(false);
  expect(observe.mock.lastCall?.[0]).toMatchObject({ final_path: '/final/', actual_status: null, response_headers: {}, reason: 'request_failed' });
  expect(JSON.stringify(observe.mock.calls)).not.toContain('secret transport');
});

it('does not read bodies for correct 404 responses or weaken failures when sampling breaks', async () => {
  const cancel = vi.fn(), pull = vi.fn(), observe = vi.fn();
  const stream = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/gone/', status: 404 }, {
    fetchImpl: async () => new Response(stream, { status: 404 }), validate: async () => {}, observe,
  })).toBe(true);
  expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce(); expect(observe).not.toHaveBeenCalled();
  const broken = new ReadableStream({ pull(c) { c.error(Error('private stream failure')); } });
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/gone/', status: 404 }, {
    fetchImpl: async () => new Response(broken), validate: async () => {}, observe,
  })).toBe(false);
  expect(observe.mock.lastCall?.[0].reason).toBe('status_mismatch');
  expect(JSON.stringify(observe.mock.calls)).not.toContain('private stream failure');
});

describe('retained WordPress file addresses', () => {
  const image = Buffer.from('jpeg bytes of the published media file');
  const files = { 'media/wp-content/uploads/2013/12/photo.jpg': { sha256: sha256(image), size: image.length } };
  const redirects = '/wp-content/uploads/2013/12/photo.jpg /media/wp-content/uploads/2013/12/photo.jpg 301';
  const check = staticManifestChecks(files, redirects).find(entry => entry.route === '/wp-content/uploads/2013/12/photo.jpg')!;
  const redirecting = (body: () => Response) => vi.fn(async (url: URL | RequestInfo) => String(url instanceof Request ? url.url : url).includes('/media/')
    ? body() : new Response(null, { status: 301, headers: { location: '/media/wp-content/uploads/2013/12/photo.jpg' } }));

  it('follows a 301 from the old file address to the published media file and verifies its bytes', async () => {
    expect(check).toMatchObject({ status: 200, sha256: sha256(image), size: image.length, redirect_target: '/media/wp-content/uploads/2013/12/photo.jpg' });
    const observe = vi.fn();
    expect(await verifyStaticResponse('https://site.example.invalid', check, { validate: async () => {}, observe, fetchImpl: redirecting(() => new Response(image)) })).toBe(true);
    expect(observe).not.toHaveBeenCalled();
  });

  it('retries a dropped connection and a timeout, then passes without counting the failed bytes', async () => {
    let calls = 0, downloaded = 0;
    const fetchImpl = redirecting(() => {
      calls++;
      if (calls === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(image.subarray(0, 8)); controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } })); } }));
      if (calls === 2) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return new Response(image);
    });
    const observe = vi.fn();
    expect(await verifyStaticResponse('https://site.example.invalid', check, { validate: async () => {}, observe, fetchImpl, retryDelayMs: 1, observeBytes: bytes => { downloaded += bytes; } })).toBe(true);
    expect(calls).toBe(3);
    expect(downloaded).toBe(image.length);
    expect(observe).not.toHaveBeenCalled();
  });

  it('names the transport cause when every attempt fails', async () => {
    const observe = vi.fn();
    const fetchImpl = redirecting(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'secret socket detail' } }); });
    expect(await verifyStaticResponse('https://site.example.invalid', check, { validate: async () => {}, observe, fetchImpl, retryDelayMs: 1 })).toBe(false);
    const failure = observe.mock.lastCall?.[0];
    expect(failure).toMatchObject({ route: '/wp-content/uploads/2013/12/photo.jpg', reason: 'connection_failed', error_code: 'ECONNRESET', attempts: 3,
      redirect_chain: [{ status: 301, to_path: '/media/wp-content/uploads/2013/12/photo.jpg' }] });
    expect(staticFailureMessage(failure)).toContain('ECONNRESET');
    expect(JSON.stringify(observe.mock.calls)).not.toContain('secret socket');
  });

  it('reports a body longer than its file as content_mismatch on that route, not a shared budget failure', async () => {
    const observe = vi.fn();
    let downloaded = 0;
    const longer = Buffer.concat([image, Buffer.alloc(64 * 1024, 1)]);
    expect(await verifyStaticResponse('https://site.example.invalid', check, { validate: async () => {}, observe, maxBytes: 256 * 1024,
      observeBytes: bytes => { downloaded += bytes; }, fetchImpl: redirecting(() => new Response(longer)) })).toBe(false);
    expect(observe.mock.lastCall?.[0]).toMatchObject({ reason: 'content_mismatch', attempts: 1 });
    expect(downloaded).toBeLessThanOrEqual(longer.length);
  });

  it('labels an exhausted coordinator budget instead of a generic request failure', async () => {
    const observe = vi.fn();
    expect(await verifyStaticResponse('https://site.example.invalid', check, { validate: async () => {}, observe, retryDelayMs: 1,
      observeBytes: () => { throw new ProbeByteBudgetError(); }, fetchImpl: redirecting(() => new Response(image)) })).toBe(false);
    expect(observe.mock.lastCall?.[0]).toMatchObject({ reason: 'probe_byte_budget', actual_status: 200, attempts: 1 });
  });
});
