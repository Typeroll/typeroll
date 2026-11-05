import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { contentAddresses, verifyStaticResponse } from '../../lib/builds/verification';

const validate = async () => {};
const origin = 'https://v-d7866092-site.example.invalid';
const bytes = Buffer.from('immutable share image bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const route = `/_assets/share/share-${digest.slice(0, 20)}.jpg`;
const removed = { route, status: 404 as const };
// The public URL still answers from a cache keyed by the URL; a fresh cache key reaches the deployment.
const edge = (variantStatus: number, body = bytes) => vi.fn(async (url: URL | RequestInfo) => new URL(String(url)).search
  ? new Response(null, { status: variantStatus })
  : new Response(body, { status: 200, headers: { 'cf-cache-status': 'HIT', age: '59', 'cf-ray': 'a55a9bf08ba4f52a-CDG' } }));

it('names only content-addressed files under /_assets/ and /media/', () => {
  expect(contentAddresses(route)).toEqual([digest.slice(0, 20)]);
  expect(contentAddresses('/media/547b0b218215bffc-logo.png')).toEqual(['547b0b218215bffc']);
  for (const other of ['/about/', '/robots.txt', '/_assets/site.css', '/blog/547b0b218215bffc-post/', '/_assets/a-547b0b2182.css']) expect(contentAddresses(other)).toEqual([]);
});
it('accepts a removed immutable file only when its bytes match its name and the deployment no longer has it', async () => {
  const onRetained = vi.fn(), fetchImpl = edge(404);
  expect(await verifyStaticResponse(origin, removed, { validate, fetchImpl, onRetained })).toBe(true);
  expect(onRetained).toHaveBeenCalledWith(expect.objectContaining({ route, sha256: digest, cf_ray: 'a55a9bf08ba4f52a-CDG' }));
  const variant = new URL(String(fetchImpl.mock.calls[1]![0]));
  expect(variant.pathname).toBe(route);
  expect(variant.searchParams.get('typeroll-cache-check')).toMatch(/^[0-9a-f-]{36}$/);
});
it('still fails when the deployment itself serves the removed file', async () => {
  const observe = vi.fn();
  expect(await verifyStaticResponse(origin, removed, { validate, fetchImpl: edge(200), observe })).toBe(false);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reason: 'status_mismatch', actual_status: 200, expected_status: 404 }));
});
it('still fails when the served bytes are not the bytes the name hashes', async () => {
  expect(await verifyStaticResponse(origin, removed, { validate, fetchImpl: edge(404, Buffer.from('different bytes')) })).toBe(false);
});
it('still fails for a removed page or a file without a content hash', async () => {
  for (const path of ['/removed-page/', '/_assets/site.css']) {
    expect(await verifyStaticResponse(origin, { route: path, status: 404 }, { validate, fetchImpl: edge(404) })).toBe(false);
  }
});
