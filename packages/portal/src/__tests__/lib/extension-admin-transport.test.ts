import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../lib/extensions/public-http', async load => ({ ...await load<object>(), assertPublicDestination: vi.fn(async () => {}) }));
import { requestApprovedAdmin } from '../../lib/extensions/admin-request';
const input = { method: 'POST' as const, page_id: 'settings', path: '/admin/settings', body: { choice: true } };
afterEach(() => vi.unstubAllGlobals());
it('never follows a redirect carrying administrator authority', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example/' } }));
  vi.stubGlobal('fetch', fetcher);
  await expect(requestApprovedAdmin(new URL('https://app.example/admin/settings'), input, 'fake', 'https://cms.example')).rejects.toThrow('redirects');
  expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'manual' }));
});
it('bounds streamed data even without content-length and keeps app error status', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(262145))));
  await expect(requestApprovedAdmin(new URL('https://app.example/admin/settings'), input, 'fake', 'https://cms.example')).rejects.toThrow('256 KiB');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Domain changed' }, { status: 409 })));
  expect(await requestApprovedAdmin(new URL('https://app.example/admin/settings'), input, 'fake', 'https://cms.example')).toEqual({ status: 409, data: { error: 'Domain changed' } });
});
