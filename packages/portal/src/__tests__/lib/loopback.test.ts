import { afterEach, describe, expect, it, vi } from 'vitest';
import { portalFetch, setLoopbackDispatch } from '../../lib/runtime/loopback';

afterEach(() => setLoopbackDispatch(null));

describe('portal loopback fetch', () => {
  it('serves requests for its own origin in process when the runtime registers a dispatch', async () => {
    const network = vi.fn(async () => new Response('network'));
    const dispatch = vi.fn(async (request: Request) => new Response(`local ${request.method} ${new URL(request.url).pathname} ${request.headers.get('authorization')} ${await request.text()}`));
    setLoopbackDispatch(dispatch);
    const fetchImpl = portalFetch('https://app.example.test', network);
    const response = await fetchImpl('https://app.example.test/api/v1/sites', { method: 'POST', headers: { Authorization: 'Bearer k' }, body: 'x' });
    expect(await response.text()).toBe('local POST /api/v1/sites Bearer k x');
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps other origins, and every origin without a dispatch, on the network', async () => {
    const network = vi.fn(async (request: Request) => new Response(`network ${new URL(request.url).host}`));
    const fetchImpl = portalFetch('https://app.example.test/', network as never);
    expect(await (await fetchImpl('https://app.example.test/api/v1/sites')).text()).toBe('network app.example.test');
    setLoopbackDispatch(async () => new Response('local'));
    expect(await (await fetchImpl('https://other.example.test/x')).text()).toBe('network other.example.test');
    expect(await (await fetchImpl('https://app.example.test.evil.test/x')).text()).toBe('network app.example.test.evil.test');
  });
});
