import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CloudflareApi, pagesProjectNameForSite } from '../../lib/hosting/cloudflare-api';

// We stub fetch so the tests never hit the real CF API. Each test sets
// up the responses it cares about.

describe('pagesProjectNameForSite', () => {
  it('lowercases and hyphenates', () => {
    expect(pagesProjectNameForSite('Org-1', 'My_Site')).toBe('tr-org-1-my-site');
  });
  it('truncates to 58 characters', () => {
    const long = pagesProjectNameForSite('a'.repeat(40), 'b'.repeat(40));
    expect(long.length).toBeLessThanOrEqual(58);
    expect(long).not.toMatch(/-$/);
  });
});

describe('CloudflareApi', () => {
  const api = new CloudflareApi({ accountId: 'acc', apiToken: 'tok' });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockJson(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it('createPagesProject sends POST with project name', async () => {
    fetchMock.mockResolvedValueOnce(mockJson(200, { result: { name: 'tr-x', subdomain: 'tr-x.pages.dev' } }));
    const out = await api.createPagesProject('tr-x');
    expect(out.name).toBe('tr-x');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/acc/pages/projects',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('tr-x'),
      }),
    );
  });

  it('createPagesProject is idempotent on 409 (returns existing)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockJson(409, { errors: [{ message: 'exists' }] }))
      .mockResolvedValueOnce(mockJson(200, { result: { name: 'tr-x', subdomain: 'tr-x.pages.dev' } }));
    const out = await api.createPagesProject('tr-x');
    expect(out.name).toBe('tr-x');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('attachCustomDomain treats 409 (already attached) as success', async () => {
    fetchMock.mockResolvedValueOnce(mockJson(409, { errors: [{ message: 'exists' }] }));
    await expect(api.attachCustomDomain('proj', 'foo.example.com')).resolves.toBeUndefined();
  });

  it('attachCustomDomain throws on other errors', async () => {
    fetchMock.mockResolvedValueOnce(mockJson(500, { errors: [{ message: 'boom' }] }));
    await expect(api.attachCustomDomain('proj', 'foo.example.com')).rejects.toThrow(/attachCustomDomain/);
  });

  it('getZoneId caches results', async () => {
    fetchMock.mockResolvedValueOnce(mockJson(200, { result: [{ id: 'z1', name: 'example.com' }] }));
    expect(await api.getZoneId('example.com')).toBe('z1');
    // No second fetch — cache hit.
    expect(await api.getZoneId('example.com')).toBe('z1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getZoneId throws when zone not found', async () => {
    fetchMock.mockResolvedValueOnce(mockJson(200, { result: [] }));
    await expect(api.getZoneId('nonexistent.example')).rejects.toThrow(/No Cloudflare zone/);
  });

  it('upsertDnsRecord creates a new record when none exists', async () => {
    fetchMock
      .mockResolvedValueOnce(mockJson(200, { result: [] })) // list: empty
      .mockResolvedValueOnce(mockJson(200, { result: { id: 'r1' } })); // create
    await api.upsertDnsRecord({
      zoneId: 'z1',
      type: 'CNAME',
      name: 'foo.example.com',
      content: 'tr-x.pages.dev',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createCall = fetchMock.mock.calls[1];
    expect(createCall[0]).toContain('/zones/z1/dns_records');
    expect(JSON.parse(createCall[1].body)).toMatchObject({
      type: 'CNAME', name: 'foo.example.com', content: 'tr-x.pages.dev',
    });
  });

  it('upsertDnsRecord updates an existing record', async () => {
    fetchMock
      .mockResolvedValueOnce(mockJson(200, { result: [{ id: 'rExisting' }] })) // list: 1 found
      .mockResolvedValueOnce(mockJson(200, { result: { id: 'rExisting' } })); // PUT update
    await api.upsertDnsRecord({
      zoneId: 'z1',
      type: 'CNAME',
      name: 'foo.example.com',
      content: 'tr-x.pages.dev',
    });
    const updateCall = fetchMock.mock.calls[1];
    expect(updateCall[0]).toContain('/zones/z1/dns_records/rExisting');
    expect(updateCall[1].method).toBe('PUT');
  });

  it('deletePagesProject treats 404 as success', async () => {
    fetchMock.mockResolvedValueOnce(mockJson(404, { errors: [{ message: 'not found' }] }));
    await expect(api.deletePagesProject('tr-x')).resolves.toBeUndefined();
  });
});
