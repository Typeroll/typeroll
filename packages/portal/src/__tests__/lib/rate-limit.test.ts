import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { rateLimit, rateLimitPath } from '../../lib/rate-limit';

describe('rateLimit', () => {
  beforeEach(async () => {
    makeTmpFixtures(); await resetDatastore();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows up to the limit, then denies further calls in the same window', async () => {
    for (let i = 0; i < 3; i++) expect((await rateLimit('unique-1', 3, 60_000)).allowed).toBe(true);
    const denied = await rateLimit('unique-1', 3, 60_000);
    expect(denied).toEqual({ allowed: false, remaining: 0, resetAt: Date.parse('2026-01-01T00:01:00Z') });
  });

  it('resets after the window elapses', async () => {
    for (let i = 0; i < 5; i++) await rateLimit('unique-2', 5, 60_000);
    expect((await rateLimit('unique-2', 5, 60_000)).allowed).toBe(false);
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect(await rateLimit('unique-2', 5, 60_000)).toMatchObject({ allowed: true, remaining: 4 });
  });

  it('isolates different keys and scopes', async () => {
    await rateLimit('a', 1, 60_000);
    expect((await rateLimit('a', 1, 60_000)).allowed).toBe(false);
    expect((await rateLimit('b', 1, 60_000)).allowed).toBe(true);
    expect((await rateLimit('a', 1, 60_000, { scope: 'organizations/o/sites/s' })).allowed).toBe(true);
  });

  it('shares one budget across concurrent requests (and isolates), storing only a key hash', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => rateLimit('shared', 5, 60_000)));
    expect(results.filter(result => result.allowed)).toHaveLength(5);
    const path = rateLimitPath('shared', { scope: 'organizations/o/' });
    expect(path).toMatch(/^organizations\/o\/rate_limits\/[a-f0-9]{64}$/);
    expect(await getStore().getDoc(rateLimitPath('shared'))).toMatchObject({ count: 5 });
    expect(JSON.stringify(await getStore().listDocs('rate_limits'))).not.toContain('shared');
  });

  it('fails closed when storage is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(getStore(), 'getDoc').mockRejectedValue(new Error('object unavailable'));
    expect(await rateLimit('down', 10, 60_000)).toMatchObject({ allowed: false, remaining: 0 });
  });
});

describe('clientIp', () => {
  afterEach(() => { delete process.env.AUTH_TRUST_PROXY_HOPS; });

  it('ignores the client-chosen leftmost X-Forwarded-For entry and X-Real-IP', async () => {
    const { clientIp } = await import('../../lib/rate-limit');
    const headers = new Headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.5', 'x-real-ip': '2.2.2.2' });
    process.env.AUTH_TRUST_PROXY_HOPS = '1';
    expect(clientIp(headers, '10.0.0.1')).toBe('203.0.113.5');
    process.env.AUTH_TRUST_PROXY_HOPS = '2';
    expect(clientIp(headers, '10.0.0.1')).toBe('1.1.1.1');
  });

  it('uses the socket address when no proxy hops are trusted', async () => {
    const { clientIp } = await import('../../lib/rate-limit');
    const headers = new Headers({ 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2' });
    expect(clientIp(headers, '192.0.2.8')).toBe('192.0.2.8');
    expect(clientIp(headers)).toBe('unknown');
  });
});
