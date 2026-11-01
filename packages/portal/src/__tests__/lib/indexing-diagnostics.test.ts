import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import type { Site } from '@typeroll/shared';
import {
  blocksAllCrawlers,
  diagnoseSiteIndexing,
  extractRobotsMeta,
} from '../../lib/indexing-diagnostics';

const site = {
  id: 'demo',
  name: 'Demo',
  hosting_adapter: 'cloudflare',
  hosting_config: { fallback_subdomain: 'demo.sites.example.test' },
  domain: 'www.example.test',
  domain_status: 'live',
  domain_verified_at: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
} satisfies Site;

function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname === '/robots.txt') {
    return Promise.resolve(new Response('User-agent: *\nAllow: /\n', { status: 200 }));
  }
  const fallback = url.hostname.startsWith('demo.sites.');
  const headers = fallback ? { 'x-robots-tag': 'noindex, nofollow' } : undefined;
  const body = init?.method === 'HEAD'
    ? null
    : '<!doctype html><meta content="index,follow" name="robots"><h1>Demo</h1>';
  return Promise.resolve(new Response(body, { status: 200, headers }));
}

describe('indexing diagnostics', () => {
  it('separates fallback edge protection, document metadata and crawl policy', async () => {
    const report = await diagnoseSiteIndexing(site, { site_name: 'Demo' } as never, {
      fetchImpl: mockFetch as typeof fetch,
      validateDestination: async () => undefined,
      now: () => new Date('2026-09-06T08:00:00.000Z'),
    });

    expect(report.ready).toBe(true);
    expect(report.checked_at).toBe('2026-09-06T08:00:00.000Z');
    expect(report.targets).toMatchObject([
      {
        kind: 'fallback', header_noindex: true, meta_noindex: false,
        effective_noindex: true, robots_txt_blocks_all: false, matches_expected: true,
      },
      {
        kind: 'production', header_noindex: false, meta_noindex: false,
        effective_noindex: false, robots_txt_blocks_all: false, matches_expected: true,
      },
    ]);
  });

  it('fails visibly when the documented fallback header is missing', async () => {
    const report = await diagnoseSiteIndexing(
      { ...site, domain: undefined, domain_status: undefined },
      { site_name: 'Demo', sitewide_noindex: true } as never,
      {
        fetchImpl: (async (input: string | URL | Request) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
          return new Response('<meta name="robots" content="noindex,nofollow">');
        }) as typeof fetch,
        validateDestination: async () => undefined,
      },
    );

    expect(report.ready).toBe(false);
    expect(report.targets[0]).toMatchObject({
      effective_noindex: true,
      header_noindex: false,
      robots_txt_blocks_all: true,
      matches_expected: true,
    });
    expect(report.issues.join(' ')).toContain('X-Robots-Tag');
  });

  it('reports a host that does not resolve yet instead of a bare ENOTFOUND', async () => {
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND demo.sites.example.test'), { code: 'ENOTFOUND' });
    const report = await diagnoseSiteIndexing({ ...site, domain: undefined, domain_status: undefined }, { site_name: 'Demo' } as never, {
      fetchImpl: mockFetch as typeof fetch,
      validateDestination: async () => { throw notFound; },
    });
    expect(report.ready).toBe(false);
    expect(report.targets[0].issues).toEqual([expect.stringContaining('does not resolve in DNS yet')]);
    expect(JSON.stringify(report)).not.toContain('getaddrinfo');
  });

  it('parses common metadata and robots.txt shapes', () => {
    expect(extractRobotsMeta("<meta content='NOINDEX, FOLLOW' name='robots'>")).toBe('NOINDEX, FOLLOW');
    expect(blocksAllCrawlers('User-agent: Googlebot\nDisallow: /\nUser-agent: *\nAllow: /')).toBe(false);
    expect(blocksAllCrawlers('User-agent: *\nDisallow: /')).toBe(true);
    expect(blocksAllCrawlers('User-agent: *\nUser-agent: Googlebot\nDisallow: /')).toBe(true);
  });

  it('validates every redirect destination before following it', async () => {
    const visited: string[] = [];
    const report = await diagnoseSiteIndexing(
      { ...site, domain: undefined, domain_status: undefined },
      { site_name: 'Demo' } as never,
      {
        fetchImpl: (async (input: string | URL | Request) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.hostname === 'demo.sites.example.test') {
            return new Response(null, { status: 302, headers: { location: 'https://internal.example.test/' } });
          }
          throw new Error('private destination must not be fetched');
        }) as typeof fetch,
        validateDestination: async (url) => {
          visited.push(url.hostname);
          if (url.hostname === 'internal.example.test') throw new Error('Destination resolved to a non-public address');
        },
      },
    );
    expect(report.ready).toBe(false);
    expect(visited).toContain('internal.example.test');
    expect(report.issues.join(' ')).toContain('non-public address');
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(['https://169.254.169.254/latest/meta-data/', 'https://[::ffff:a9fe:a9fe]/latest/meta-data/', 'https://127.0.0.1/', 'https://[64:ff9b::7f00:1]/'])(
    'never follows a redirect to the IP literal %s with the default validator',
    async (location) => {
      vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
      const fetched: string[] = [];
      const report = await diagnoseSiteIndexing(
        { ...site, domain: undefined, domain_status: undefined },
        { site_name: 'Demo' } as never,
        {
          fetchImpl: (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : input.toString());
            fetched.push(url.hostname);
            if (url.hostname === 'demo.sites.example.test') return new Response(null, { status: 302, headers: { location } });
            return new Response('metadata secret', { status: 200 });
          }) as typeof fetch,
        },
      );
      expect(fetched.every((host) => host === 'demo.sites.example.test')).toBe(true);
      expect(report.ready).toBe(false);
    },
  );
});


it('expects the platform robots block on a customer temporary host independently of authored noindex', async () => {
  const temporary = { ...site, publishing_mode: 'customer_git' as const, domain: 'demo.sites.example.test' };
  const options = { fetchImpl: mockFetch as typeof fetch, validateDestination: async () => undefined };
  const blocked = await diagnoseSiteIndexing(temporary, { sitewide_noindex: false } as never, { ...options, robotsBlocked: true });
  expect(blocked.ready).toBe(true);
  expect(blocked.targets).toMatchObject([{ expected: 'noindex', expectation_reason: 'platform_robots_blocked', matches_expected: true }]);
  const publicSite = await diagnoseSiteIndexing(temporary, { sitewide_noindex: false } as never, options);
  expect(publicSite.ready).toBe(false);
  expect(publicSite.issues.join(' ')).toContain('Expected an indexable document');
});

it('reports previous addresses as redirected or noindex rather than indexable copies', async () => {
  const old = 'old.example.com';
  for (const redirect of [true, false]) {
    const report = await diagnoseSiteIndexing({ ...site, publishing_mode: 'customer_git' }, { site_name: 'Demo' } as never, {
      publicationId: 'publication', previousHosts: [{ host: old, target_host: 'www.example.test', mode: 'noindex', status: 'pending', message: '' }],
      validateDestination: async () => {},
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname !== old) return mockFetch(input, init);
        if (redirect) return new Response(null, { status: 301, headers: { location: url.href.replace(old, 'www.example.test') } });
        return new Response('old content', { headers: { 'x-robots-tag': 'noindex, nofollow', 'x-typeroll-publication': 'publication' } });
      },
    });
    expect(report.ready).toBe(true);
    expect(report.previous_hosts?.[0]).toMatchObject({ host: old, mode: redirect ? 'redirect' : 'noindex', status: redirect ? 'verified' : 'warning' });
  }
});
