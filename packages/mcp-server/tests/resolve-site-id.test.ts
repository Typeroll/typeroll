// resolveSiteId — site discovery at stdio startup. Fake client, no network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveSiteId, type SiteListItem } from '../src/resolve-site-id.js';
import type { TyperollClient } from '../src/client.js';

function fakeClient(sites: SiteListItem[]): TyperollClient {
  return { rootGet: async () => ({ sites }) } as unknown as TyperollClient;
}

const savedEnv = process.env.TYPEROLL_SITE_ID;
beforeEach(() => {
  delete process.env.TYPEROLL_SITE_ID;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TYPEROLL_SITE_ID;
  else process.env.TYPEROLL_SITE_ID = savedEnv;
});

describe('resolveSiteId', () => {
  it('TYPEROLL_SITE_ID wins without calling the API', async () => {
    process.env.TYPEROLL_SITE_ID = 'pinned';
    const client = { rootGet: async () => { throw new Error('should not be called'); } } as unknown as TyperollClient;
    expect(await resolveSiteId(client)).toBe('pinned');
  });

  it('binds to the single site a site-scoped key returns', async () => {
    expect(await resolveSiteId(fakeClient([{ id: 'mysite', name: 'My Site' }]))).toBe('mysite');
  });

  it('demands TYPEROLL_SITE_ID when the key reaches multiple sites', async () => {
    await expect(
      resolveSiteId(fakeClient([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])),
    ).rejects.toThrow(/TYPEROLL_SITE_ID/);
  });

  it('errors on an empty list', async () => {
    await expect(resolveSiteId(fakeClient([]))).rejects.toThrow(/No sites/);
  });

  it('rejects a single placeholder entry with an empty id (older portals)', async () => {
    await expect(
      resolveSiteId(fakeClient([{ id: '', name: '' }])),
    ).rejects.toThrow(/empty id/);
  });
});
