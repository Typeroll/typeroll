import { describe, expect, it } from 'vitest';
import { buildPagesHeaders, withGlobalHeaders } from '../../lib/deploy/pages-headers';

describe('buildPagesHeaders', () => {
  it('keeps cache, security and marker headers together when updating global rules', () => {
    const stamped = withGlobalHeaders(buildPagesHeaders() + '\n/*\n  X-Robots-Tag: noindex\n', { 'X-Typeroll-Publication': 'first' });
    const updated = withGlobalHeaders(stamped, { 'X-Typeroll-Publication': 'second' });
    expect(updated.split('\n').filter(line => line === '/*')).toHaveLength(1);
    expect(updated).toContain('Cache-Control: public, no-cache, max-age=0, must-revalidate, no-transform');
    expect(updated).toContain('X-Robots-Tag: noindex');
    expect(updated).toContain('X-Typeroll-Publication: second');
    expect(updated).not.toContain('X-Typeroll-Publication: first');
    expect(updated).toContain('X-Content-Type-Options: nosniff');
  });
  it('preserves the portable cache and security defaults', () => {
    const headers = buildPagesHeaders();

    expect(headers).toContain('/*\n  X-Content-Type-Options: nosniff');
    expect(headers).toContain('/_astro/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable');
    expect(headers).toContain('/_assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable');
    // Mutable routes share revalidation; more-specific rules would append
    // conflicting max-age directives instead of overriding the global rule.
    expect(headers).not.toContain('/robots.txt\n');
    expect(headers).not.toContain('/sitemap.xml\n');
    expect(headers).not.toContain('/sitemap-images.xml\n');
    expect(headers.split('\n').filter(line => line.includes('Cache-Control:')).every(line => line.includes('no-transform'))).toBe(true);
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
