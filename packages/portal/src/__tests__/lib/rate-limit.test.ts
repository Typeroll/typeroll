import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rateLimit } from '../../lib/rate-limit';

describe('rateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to the limit, then denies further calls in the same window', () => {
    const limit = 3;
    const win = 60_000;
    const key = 'unique-1';
    for (let i = 0; i < limit; i++) {
      const r = rateLimit(key, limit, win);
      expect(r.allowed).toBe(true);
    }
    const r = rateLimit(key, limit, win);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('resets after the window elapses', () => {
    const key = 'unique-2';
    for (let i = 0; i < 5; i++) rateLimit(key, 5, 60_000);
    expect(rateLimit(key, 5, 60_000).allowed).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect(rateLimit(key, 5, 60_000).allowed).toBe(true);
  });

  it('isolates different keys', () => {
    rateLimit('a', 1, 60_000);
    expect(rateLimit('a', 1, 60_000).allowed).toBe(false);
    expect(rateLimit('b', 1, 60_000).allowed).toBe(true);
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
