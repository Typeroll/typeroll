import { describe, expect, it } from 'vitest';
import { buildPagesHeaders } from '../../lib/deploy/pages-headers';

describe('buildPagesHeaders', () => {
  it('preserves the portable cache and security defaults', () => {
    const headers = buildPagesHeaders();

    expect(headers).toContain('/*\n  X-Content-Type-Options: nosniff');
    expect(headers).toContain('/_astro/*\n  Cache-Control: public, max-age=31536000, immutable');
    expect(headers).toContain('/robots.txt\n  Cache-Control: public, max-age=3600');
  });

  it('adds noindex only for the hosted fallback namespace', () => {
    const headers = buildPagesHeaders('SITES.TYPEROLL.COM.');

    expect(headers).toContain(
      'https://:site.sites.typeroll.com/*\n  X-Robots-Tag: noindex, nofollow',
    );
    expect(headers).not.toContain('www.example.com');
  });

  it('does not add a hosted fallback policy for self-hosted builds', () => {
    expect(buildPagesHeaders()).not.toContain('X-Robots-Tag');
    expect(buildPagesHeaders('   ')).not.toContain('X-Robots-Tag');
  });

  it.each([
    'https://sites.typeroll.com',
    'sites.typeroll.com/path',
    'sites.typeroll.com:443',
    '*.sites.typeroll.com',
    'localhost',
  ])('rejects an invalid base domain: %s', (value) => {
    expect(() => buildPagesHeaders(value)).toThrow(`Invalid SITES_BASE_DOMAIN: ${value}`);
  });
});
