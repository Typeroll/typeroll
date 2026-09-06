import { describe, expect, it } from 'vitest';
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
});
