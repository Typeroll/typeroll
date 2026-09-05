import { describe, it, expect } from 'vitest';
import { buildRedirectsFile } from '../../lib/deploy/runner';
import { partitionShadowedRedirects } from '../../lib/redirect-hygiene';
import type { Site } from '@typeroll/shared';

const baseSite: Partial<Site> = {
  id: 's', name: 's', hosting_adapter: 'cloudflare',
  created_at: '2024-01-01',
};

describe('buildRedirectsFile', () => {
  it('returns null when there is nothing to emit', () => {
    expect(buildRedirectsFile(baseSite as Site, [])).toBeNull();
    expect(buildRedirectsFile(null, [])).toBeNull();
  });

  it('emits user redirects only when no pair is set', () => {
    const out = buildRedirectsFile(baseSite as Site, [
      { from_path: '/old', to_path: '/new', status_code: 301 },
    ]);
    expect(out).toBe('/old/ /new 301\n/old /new 301\n');
  });

  it('emits cross-host canonical line FIRST when an apex/www pair is set', () => {
    const site = {
      ...baseSite,
      domain: 'autopilot.se',
      domain_alias: 'www.autopilot.se',
    } as Site;
    const out = buildRedirectsFile(site, [
      { from_path: '/old', to_path: '/new', status_code: 301 },
    ]);
    const lines = out!.trim().split('\n');
    expect(lines[0]).toBe('https://www.autopilot.se/* https://autopilot.se/:splat 301!');
    expect(lines.slice(1)).toEqual(['/old/ /new 301', '/old /new 301']);
  });

  it('the canonical line uses force (!) so user redirects cannot shadow it', () => {
    const site = {
      ...baseSite,
      domain: 'autopilot.se',
      domain_alias: 'www.autopilot.se',
    } as Site;
    const out = buildRedirectsFile(site, []);
    expect(out).toContain(' 301!');
  });

  it('honours www-as-canonical sites (redirect goes apex → www)', () => {
    const site = {
      ...baseSite,
      domain: 'www.autopilot.se',
      domain_alias: 'autopilot.se',
      domain_canonical: 'www' as const,
    } as Site;
    const out = buildRedirectsFile(site, []);
    expect(out).toContain('https://autopilot.se/* https://www.autopilot.se/:splat 301!');
  });

  it('does NOT emit a canonical line when the site is single-domain (subdomain)', () => {
    const site = {
      ...baseSite,
      domain: 'shop.example.com',
      // domain_alias undefined — single-domain subdomain registration
    } as Site;
    const out = buildRedirectsFile(site, [
      { from_path: '/old', to_path: '/new', status_code: 301 },
    ]);
    expect(out).toBe('/old/ /new 301\n/old /new 301\n');
    expect(out).not.toContain('https://');
  });

  it('preserves path through :splat token', () => {
    const site = {
      ...baseSite,
      domain: 'autopilot.se',
      domain_alias: 'www.autopilot.se',
    } as Site;
    const out = buildRedirectsFile(site, []);
    expect(out).toContain('/:splat');
  });
});

// Regression: the gruppsupporter incident — a stale "/" auto-redirect made
// it into `_redirects` after a new home page was published, and CF Pages
// served the redirect instead of the page. The deploy runner now partitions
// out any rule whose from_path a built page owns.
describe('partitionShadowedRedirects', () => {
  const rules = [
    { from_path: '/', to_path: '/home-html-legacy', status_code: 301 as const },
    { from_path: '/old', to_path: '/new', status_code: 301 as const },
  ];

  it('drops rules whose from_path collides with a live page URL', () => {
    const { kept, shadowed } = partitionShadowedRedirects(rules, new Set(['/']));
    expect(kept).toEqual([rules[1]]);
    expect(shadowed).toEqual([rules[0]]);
  });

  it('keeps everything when no page owns a from_path', () => {
    const { kept, shadowed } = partitionShadowedRedirects(rules, new Set(['/about']));
    expect(kept).toEqual(rules);
    expect(shadowed).toEqual([]);
  });

  it('shadowed rules never reach the _redirects body', () => {
    const { kept } = partitionShadowedRedirects(rules, new Set(['/']));
    const out = buildRedirectsFile(baseSite as Site, kept);
    expect(out).toBe('/old/ /new 301\n/old /new 301\n');
  });

  it('emits both observed Moveria source variants to the canonical target', () => {
    const out = buildRedirectsFile(baseSite as Site, [
      { from_path: '/stadning-detaljer', to_path: '/offert_flyttstadning', status_code: 301 },
      { from_path: '/flyttfirma-detaljer', to_path: '/flyttfirmeoffert', status_code: 301 },
    ], 'always');
    expect(out).toContain('/stadning-detaljer /offert_flyttstadning/ 301\n');
    expect(out).toContain('/stadning-detaljer/ /offert_flyttstadning/ 301\n');
    expect(out).toContain('/flyttfirma-detaljer /flyttfirmeoffert/ 301\n');
    expect(out).toContain('/flyttfirma-detaljer/ /flyttfirmeoffert/ 301\n');
  });
});
